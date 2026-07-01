/**
 * Confidence-deepening orchestrator (Workstream C) — PURE: no LLM, no DB. It drives the analyst
 * desk in rounds when adversarial verification is short of the bar, escalating on the wired sources
 * (source-gap fill -> re-lens -> bump model tier), and stops at the best-so-far artifact when the
 * bar is met or budget/rounds exhaust. All side-effects (LLM calls, source fetches, ledger reads)
 * are injected as `steps`, so it is fully deterministic in tests.
 */
import type { ExpertContribution, ThesisSynthesis, VerificationResult } from "./research";
import type { DeskConfig, DeepeningLever } from "../config/desk";
import { CostCeilingError } from "../llm/client";
import type { DeskManager, ManagerState } from "./desk_manager";

export interface EnrichResult { appended: string; sources: string[]; queries?: string[] }

export interface DeepenSteps {
  runPanel(evidence: string, tier: string, focus?: string[]): Promise<ExpertContribution[]>;
  synthesize(panel: ExpertContribution[], evidence: string): Promise<ThesisSynthesis>;
  verify(thesis: ThesisSynthesis, panel: ExpertContribution[], evidence: string): Promise<VerificationResult>;
  /** Source-gap fill on the wired sources (EDGAR deeper read + targeted Perplexity). */
  enrich?(input: { missing: string[]; unverified: string[] }): Promise<EnrichResult | null>;
  /** Optional per-asset budget gate; return false to stop deepening before the next round. */
  withinBudget?(): Promise<boolean>;
  /** The LLM "middle management" that runs the desk: when present, IT decides each round's move
   *  (enrich / reanalyze / conclude) instead of the fixed ladder. */
  manager?: DeskManager;
}

export interface DeepenInput { company?: { legal_name: string; ticker: string | null }; evidence: string; focus?: string[] }

export interface DeepeningRound {
  round: number;
  lever: "baseline" | DeepeningLever;
  tier: string;
  confidence: number;
  contradicted: number;
  unverified: number;
  missing_sources: string[];
  enriched?: { queries: string[]; sources: string[]; chars: number };
  llm_calls: number;
  cleared: boolean;
}

export type DeepeningStop =
  | "cleared" | "rounds_exhausted" | "budget_exhausted" | "cost_ceiling"
  | "levers_disabled" | "disabled" | "step_error" | "manager_hold";

export interface ManagerStep { round: number; action: string; escalate: boolean; focus: string[]; verdict: string | null; rationale: string; confidence_after: number }

export interface DeepeningTrace {
  bar: number;
  rounds: DeepeningRound[];
  final_round: number;
  cleared: boolean;
  stopped_reason: DeepeningStop;
  published_below_bar: boolean;
  llm_calls_total: number;
  tiers_used: string[];
  driver: "ladder" | "manager";
  manager_log?: ManagerStep[];
}

export interface DeepeningResult {
  panel: ExpertContribution[];
  thesis: ThesisSynthesis;
  verification: VerificationResult;
  trace: DeepeningTrace;
}

type Artifact = { panel: ExpertContribution[]; thesis: ThesisSynthesis; verification: VerificationResult };

const countContradicted = (v: VerificationResult): number => v.verdicts.filter((x) => x.status === "contradicted").length;
const countUnverified = (v: VerificationResult): number => v.verdicts.filter((x) => x.status === "unverified").length;
const countSupported = (v: VerificationResult): number => v.verdicts.filter((x) => x.status === "supported").length;

/** Deterministic publish gate: high enough confidence AND no more than the allowed contradictions. */
export function isCleared(v: VerificationResult, c: DeskConfig): boolean {
  return v.confidence >= c.confidenceBar && countContradicted(v) <= c.maxContradicted;
}

/** Substance-based publishability for educational research: no contradicted claims and the load-bearing
 *  claims are supported (supported outnumber unverified). Used as the manager's fallback when it runs out
 *  of rounds without an explicit verdict — a conservative confidence FLOAT shouldn't bury a well-sourced
 *  thesis with zero contradictions. */
export function publishableBySubstance(v: VerificationResult, c: DeskConfig): boolean {
  return countContradicted(v) <= c.maxContradicted && countSupported(v) > 0 && countSupported(v) >= countUnverified(v);
}

/** Prefer a cleared artifact over a non-cleared one; within the same class, prefer higher confidence. */
function better(candidate: Artifact, current: Artifact, c: DeskConfig): boolean {
  const cc = isCleared(candidate.verification, c);
  const cur = isCleared(current.verification, c);
  if (cc !== cur) return cc;
  return candidate.verification.confidence > current.verification.confidence;
}

export async function deepenToConfidence(steps: DeepenSteps, config: DeskConfig, input: DeepenInput): Promise<DeepeningResult> {
  let evidence = input.evidence;
  const rounds: DeepeningRound[] = [];
  const tiers = new Set<string>([config.synthModel, config.verifyModel]);
  let calls = 0;
  let tierIdx = 0;

  const record = (lever: DeepeningRound["lever"], tier: string, v: VerificationResult, roundCalls: number, enriched?: DeepeningRound["enriched"]): void => {
    rounds.push({
      round: rounds.length, lever, tier,
      confidence: v.confidence, contradicted: countContradicted(v), unverified: countUnverified(v),
      missing_sources: v.missing_sources, enriched, llm_calls: roundCalls, cleared: isCleared(v, config),
    });
  };

  // Round 0 — the baseline pass (identical to today's single-pass runResearch). A CostCeilingError
  // here rethrows: there is no artifact to fall back to, exactly as before Workstream C.
  const tier0 = config.lensTierLadder[0];
  tiers.add(tier0);
  const basePanel = await steps.runPanel(evidence, tier0);
  const baseThesis = await steps.synthesize(basePanel, evidence);
  const baseVerify = await steps.verify(baseThesis, basePanel, evidence);
  calls += config.lensCount + 2;
  let best: Artifact = { panel: basePanel, thesis: baseThesis, verification: baseVerify };
  record("baseline", tier0, baseVerify, config.lensCount + 2);

  let stopped: DeepeningStop;
  const managerMode = !!steps.manager;
  const managerLog: ManagerStep[] = [];
  let managerConcluded = false;
  let managerConfident = false;

  if (isCleared(best.verification, config)) stopped = "cleared";
  else if (config.maxRounds <= 0) stopped = "disabled";
  else if (managerMode) stopped = "rounds_exhausted";
  else if (config.ladder.every((l) => !config.levers[l])) stopped = "levers_disabled";
  else stopped = "rounds_exhausted";

  // ---- Manager-driven loop: the LLM head-of-research decides each round's move. ----
  const mkState = (round: number, budgetNote: string): ManagerState => ({
    company: input.company ?? { legal_name: "the company", ticker: null },
    round, maxRounds: config.maxRounds,
    confidence: best.verification.confidence, bar: config.confidenceBar,
    thesis: { one_liner: best.thesis.one_liner, long_form: best.thesis.long_form, conviction: best.thesis.conviction },
    verdicts: best.verification.verdicts.map((v) => ({ claim: v.claim, status: v.status })),
    missing_sources: best.verification.missing_sources,
    history: managerLog.map((m) => ({ round: m.round, action: m.action + (m.escalate ? "+esc" : ""), focus: m.focus, confidence_after: m.confidence_after })),
    budget_note: budgetNote,
  });

  if (managerMode && stopped === "rounds_exhausted") {
    let round = 0;
    while (round < config.maxRounds) {
      if (steps.withinBudget && !(await steps.withinBudget())) { stopped = "budget_exhausted"; break; }
      let decision;
      try {
        decision = await steps.manager!.decide(mkState(round, `~${Math.max(0, config.maxLlmCallsPerRun - calls)} desk calls of budget left.`));
        calls += 1;
      } catch (e) {
        if (e instanceof CostCeilingError) { stopped = "cost_ceiling"; break; }
        console.warn(`[deepen] manager decide failed: ${(e as Error).message}`);
        stopped = "step_error"; break;
      }

      if (decision.action === "conclude") {
        managerConcluded = true;
        managerConfident = decision.verdict === "confident" && countContradicted(best.verification) <= config.maxContradicted;
        managerLog.push({ round, action: "conclude", escalate: false, focus: decision.focus, verdict: decision.verdict, rationale: decision.rationale, confidence_after: best.verification.confidence });
        stopped = managerConfident ? "cleared" : "manager_hold";
        break;
      }

      const est = decision.action === "enrich"
        ? Math.min(decision.focus.length || best.verification.missing_sources.length, config.enrichPerplexityBudget) + 1
        : config.lensCount + 2;
      if (calls + est > config.maxLlmCallsPerRun) { stopped = "budget_exhausted"; break; }

      let confAfter = best.verification.confidence;
      try {
        if (decision.action === "enrich" && steps.enrich) {
          const unverified = best.verification.verdicts.filter((v) => v.status === "unverified").map((v) => v.claim);
          const topics = decision.focus.length ? decision.focus : best.verification.missing_sources;
          const e = await steps.enrich({ missing: topics, unverified });
          if (e?.appended) {
            evidence += `\n\nAdditional verified context (manager enrich):\n${e.appended.slice(0, config.enrichCharBudget)}`;
            const roundCalls = (e.queries?.length ?? 0) + 1; calls += roundCalls;
            const verification = await steps.verify(best.thesis, best.panel, evidence);
            const candidate: Artifact = { panel: best.panel, thesis: best.thesis, verification };
            record("enrich", config.lensTierLadder[tierIdx], verification, roundCalls, { queries: e.queries ?? [], sources: e.sources, chars: Math.min(e.appended.length, config.enrichCharBudget) });
            if (better(candidate, best, config)) best = candidate;
            confAfter = verification.confidence;
          }
        } else {
          if (decision.escalate) tierIdx = Math.min(tierIdx + 1, config.lensTierLadder.length - 1);
          const tier = config.lensTierLadder[tierIdx]; tiers.add(tier);
          const focus = decision.focus.length ? decision.focus : input.focus;
          const panel = await steps.runPanel(evidence, tier, focus);
          const thesis = await steps.synthesize(panel, evidence);
          const verification = await steps.verify(thesis, panel, evidence);
          const roundCalls = config.lensCount + 2; calls += roundCalls;
          const candidate: Artifact = { panel, thesis, verification };
          record(decision.escalate ? "bump_tier" : "relens", tier, verification, roundCalls);
          if (better(candidate, best, config)) best = candidate;
          confAfter = verification.confidence;
        }
        managerLog.push({ round, action: decision.action, escalate: decision.escalate, focus: decision.focus, verdict: null, rationale: decision.rationale, confidence_after: confAfter });
        if (isCleared(best.verification, config)) { stopped = "cleared"; managerConcluded = true; managerConfident = true; break; }
      } catch (e) {
        if (e instanceof CostCeilingError) { stopped = "cost_ceiling"; break; }
        console.warn(`[deepen] manager action ${decision.action} failed, continuing: ${(e as Error).message}`);
      }
      round++;
    }

    // The manager used all its work-rounds without an explicit verdict → give it one final CONCLUDE turn
    // so a well-supported thesis isn't buried by the conservative confidence float. If it still won't
    // commit, fall back to substance (no contradictions + supported majority).
    if (!managerConcluded && stopped === "rounds_exhausted") {
      try {
        const fin = await steps.manager!.decide(mkState(config.maxRounds, "FINAL TURN — no rounds left. You MUST conclude now: verdict 'confident' if the load-bearing claims are supported with no contradictions, else 'hold'."));
        calls += 1;
        managerConcluded = true;
        managerConfident = fin.verdict != null
          ? fin.verdict === "confident" && countContradicted(best.verification) <= config.maxContradicted
          : publishableBySubstance(best.verification, config);
        managerLog.push({ round: config.maxRounds, action: "conclude", escalate: false, focus: fin.focus, verdict: fin.verdict ?? (managerConfident ? "confident" : "hold"), rationale: fin.rationale, confidence_after: best.verification.confidence });
        stopped = managerConfident ? "cleared" : "manager_hold";
      } catch (e) {
        if (e instanceof CostCeilingError) stopped = "cost_ceiling";
        else {
          managerConcluded = true;
          managerConfident = publishableBySubstance(best.verification, config);
          stopped = managerConfident ? "cleared" : "manager_hold";
        }
      }
    }
  }

  // ---- Fallback: the fixed enrich→relens→bump_tier ladder (used when no manager is wired). ----
  let deepRounds = 0;
  if (!managerMode && stopped === "rounds_exhausted") {
    for (const lever of config.ladder) {
      if (deepRounds >= config.maxRounds) { stopped = "rounds_exhausted"; break; }
      if (!config.levers[lever]) continue;

      // Budget belts: nominal per-run call ceiling, then the per-asset USD ledger check.
      const est = lever === "enrich"
        ? Math.min(best.verification.missing_sources.length, config.enrichPerplexityBudget) + 1
        : config.lensCount + 2;
      if (calls + est > config.maxLlmCallsPerRun) { stopped = "budget_exhausted"; break; }
      if (steps.withinBudget && !(await steps.withinBudget())) { stopped = "budget_exhausted"; break; }

      try {
        if (lever === "enrich") {
          if (!steps.enrich) continue; // lever unavailable this run — not a spent round
          const unverified = best.verification.verdicts.filter((v) => v.status === "unverified").map((v) => v.claim);
          const e = await steps.enrich({ missing: best.verification.missing_sources, unverified });
          if (!e || !e.appended) continue; // nothing gathered — skip without burning a round
          const chars = Math.min(e.appended.length, config.enrichCharBudget);
          evidence += `\n\nAdditional verified context (deepening enrich):\n${e.appended.slice(0, config.enrichCharBudget)}`;
          const roundCalls = (e.queries?.length ?? 0) + 1;
          calls += roundCalls;
          // Re-verify the SAME thesis+panel against the richer evidence.
          const verification = await steps.verify(best.thesis, best.panel, evidence);
          const candidate: Artifact = { panel: best.panel, thesis: best.thesis, verification };
          record("enrich", tiers.has(config.lensTierLadder[tierIdx]) ? config.lensTierLadder[tierIdx] : tier0, verification, roundCalls,
            { queries: e.queries ?? [], sources: e.sources, chars });
          if (better(candidate, best, config)) best = candidate;
        } else {
          if (lever === "bump_tier") tierIdx = Math.min(tierIdx + 1, config.lensTierLadder.length - 1);
          const tier = config.lensTierLadder[tierIdx];
          tiers.add(tier);
          const panel = await steps.runPanel(evidence, tier);
          const thesis = await steps.synthesize(panel, evidence);
          const verification = await steps.verify(thesis, panel, evidence);
          const roundCalls = config.lensCount + 2;
          calls += roundCalls;
          const candidate: Artifact = { panel, thesis, verification };
          record(lever, tier, verification, roundCalls);
          if (better(candidate, best, config)) best = candidate;
        }
        deepRounds++;
        if (isCleared(best.verification, config)) { stopped = "cleared"; break; }
      } catch (e) {
        if (e instanceof CostCeilingError) { stopped = "cost_ceiling"; break; }
        // A transient failure in one lever must NOT abort the stronger levers still ahead (a flaky
        // relens shouldn't prevent bump_tier). Skip this round, keep best-so-far, keep escalating.
        console.warn(`[deepen] lever ${lever} failed, continuing: ${(e as Error).message}`);
        continue;
      }
    }
  }

  // Manager mode: the manager's "confident" conclusion decides (or, if it ran out of rounds without
  // concluding, fall back to the numeric bar). Non-manager mode: the numeric bar. Either way, a
  // standing contradicted claim is a hard block on publishing (compliance safety, enforced in code).
  let cleared = managerConcluded ? managerConfident : isCleared(best.verification, config);
  cleared = cleared && countContradicted(best.verification) <= config.maxContradicted;
  const published_below_bar = !cleared && config.publishBelowBarAfterExhaustion;
  // The single downstream gate reads recommendation; drive it from the resolved decision, not the model.
  best.verification.recommendation = cleared ? "auto" : "review";

  const trace: DeepeningTrace = {
    bar: config.confidenceBar, rounds, final_round: rounds.length - 1, cleared,
    stopped_reason: cleared ? "cleared" : stopped, published_below_bar,
    llm_calls_total: calls, tiers_used: [...tiers],
    driver: managerMode ? "manager" : "ladder",
    manager_log: managerMode ? managerLog : undefined,
  };
  return { ...best, trace };
}
