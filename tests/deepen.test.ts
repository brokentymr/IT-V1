/**
 * Pure orchestrator tests for the confidence-deepening loop (Workstream C). No LLM, no DB — the
 * DeepenSteps are scripted so every escalation path is deterministic.
 */
import { describe, it, expect } from "vitest";
import { deepenToConfidence, isCleared, type DeepenSteps } from "../lib/engines/deepen";
import { CostCeilingError } from "../lib/llm/client";
import { DESK_CONFIG, type DeskConfig } from "../lib/config/desk";
import type { DeskManager, ManagerDecision } from "../lib/engines/desk_manager";
import type { ThesisSynthesis, VerificationResult } from "../lib/engines/research";

const cfg = (o: Partial<DeskConfig> = {}): DeskConfig => ({ ...DESK_CONFIG, ...o });

const verif = (confidence: number, opts: { contradicted?: number; unverified?: number; supported?: number; missing?: string[] } = {}): VerificationResult => ({
  verdicts: [
    ...Array.from({ length: opts.contradicted ?? 0 }, (_, i) => ({ claim: `c${i}`, status: "contradicted" as const, note: "" })),
    ...Array.from({ length: opts.unverified ?? 0 }, (_, i) => ({ claim: `u${i}`, status: "unverified" as const, note: "" })),
    ...Array.from({ length: opts.supported ?? 0 }, (_, i) => ({ claim: `s${i}`, status: "supported" as const, note: "" })),
  ],
  confidence,
  missing_sources: opts.missing ?? ["earnings call transcript"],
  recommendation: "review",
});

interface Script {
  verifies: VerificationResult[];
  enrich?: boolean;
  throwOnVerifyCall?: number;
  throwOnPanelCall?: number;
  withinBudget?: () => Promise<boolean>;
}

function scripted(s: Script) {
  const counts = { panel: 0, synth: 0, verify: 0, enrich: 0 };
  const steps: DeepenSteps = {
    async runPanel() {
      const i = counts.panel++;
      if (s.throwOnPanelCall === i) throw new CostCeilingError("ceiling");
      return [];
    },
    async synthesize() { counts.synth++; return {} as unknown as ThesisSynthesis; },
    async verify() {
      const i = counts.verify++;
      if (s.throwOnVerifyCall === i) throw new CostCeilingError("ceiling");
      return s.verifies[Math.min(i, s.verifies.length - 1)];
    },
    ...(s.enrich ? { async enrich() { counts.enrich++; return { appended: "more context", sources: ["s1"], queries: ["q1"] }; } } : {}),
    ...(s.withinBudget ? { withinBudget: s.withinBudget } : {}),
  };
  return { steps, counts };
}

describe("isCleared", () => {
  it("gates on the confidence bar", () => {
    expect(isCleared(verif(0.8), cfg())).toBe(true);
    expect(isCleared(verif(0.7), cfg())).toBe(false);
  });
  it("hard-blocks any contradicted verdict regardless of confidence", () => {
    expect(isCleared(verif(0.95, { contradicted: 1 }), cfg())).toBe(false);
  });
});

describe("deepenToConfidence", () => {
  it("1) clears at round 0 and never deepens", async () => {
    const { steps, counts } = scripted({ verifies: [verif(0.9)] });
    const r = await deepenToConfidence(steps, cfg(), { evidence: "e" });
    expect(r.trace.stopped_reason).toBe("cleared");
    expect(r.trace.rounds).toHaveLength(1);
    expect(r.trace.rounds[0].lever).toBe("baseline");
    expect(r.verification.recommendation).toBe("auto");
    expect(counts.enrich).toBe(0);
    expect(counts.panel).toBe(1);
    expect(counts.verify).toBe(1);
  });

  it("2) enrich raises confidence over the bar", async () => {
    const { steps, counts } = scripted({ verifies: [verif(0.5), verif(0.8)], enrich: true });
    const r = await deepenToConfidence(steps, cfg(), { evidence: "e" });
    expect(r.trace.stopped_reason).toBe("cleared");
    expect(r.trace.rounds[1].lever).toBe("enrich");
    expect(counts.verify).toBe(2);
    expect(counts.panel).toBe(1); // enrich re-verifies the same panel
    expect(counts.enrich).toBe(1);
  });

  it("3) climbs the full ladder, bump_tier reaches the top tier", async () => {
    const { steps } = scripted({ verifies: [verif(0.5), verif(0.55), verif(0.6), verif(0.9)], enrich: true });
    const r = await deepenToConfidence(steps, cfg(), { evidence: "e" });
    expect(r.trace.rounds.map((x) => x.lever)).toEqual(["baseline", "enrich", "relens", "bump_tier"]);
    expect(r.trace.rounds[3].tier).toBe(DESK_CONFIG.lensTierLadder[1]);
    expect(r.trace.stopped_reason).toBe("cleared");
  });

  it("4) never clears -> rounds_exhausted, keeps max-confidence best, forces review", async () => {
    const { steps } = scripted({ verifies: [verif(0.5), verif(0.55), verif(0.6), verif(0.62)], enrich: true });
    const r = await deepenToConfidence(steps, cfg({ publishBelowBarAfterExhaustion: true }), { evidence: "e" });
    expect(r.trace.stopped_reason).toBe("rounds_exhausted");
    expect(r.trace.cleared).toBe(false);
    expect(r.verification.confidence).toBe(0.62); // best-so-far = highest confidence
    expect(r.verification.recommendation).toBe("review");
    expect(r.trace.published_below_bar).toBe(true);
  });

  it("5) per-run call ceiling stops before the last round", async () => {
    const { steps } = scripted({ verifies: [verif(0.5), verif(0.55), verif(0.6)], enrich: true });
    const r = await deepenToConfidence(steps, cfg({ maxLlmCallsPerRun: 14 }), { evidence: "e" });
    expect(r.trace.stopped_reason).toBe("budget_exhausted");
    expect(r.trace.rounds.map((x) => x.lever)).toEqual(["baseline", "enrich", "relens"]);
  });

  it("5b) withinBudget=false stops deepening", async () => {
    const { steps, counts } = scripted({ verifies: [verif(0.5)], enrich: true, withinBudget: async () => false });
    const r = await deepenToConfidence(steps, cfg(), { evidence: "e" });
    expect(r.trace.stopped_reason).toBe("budget_exhausted");
    expect(counts.enrich).toBe(0);
  });

  it("6) CostCeilingError mid-loop stops at best-so-far, does not throw", async () => {
    const { steps } = scripted({ verifies: [verif(0.5)], enrich: true, throwOnVerifyCall: 1 });
    const r = await deepenToConfidence(steps, cfg(), { evidence: "e" });
    expect(r.trace.stopped_reason).toBe("cost_ceiling");
    expect(r.verification.confidence).toBe(0.5);
    expect(r.trace.rounds).toHaveLength(1);
  });

  it("7) CostCeilingError at round 0 rethrows", async () => {
    const { steps } = scripted({ verifies: [verif(0.5)], throwOnVerifyCall: 0 });
    await expect(deepenToConfidence(steps, cfg(), { evidence: "e" })).rejects.toBeInstanceOf(CostCeilingError);
  });

  it("8) high confidence but contradicted -> not cleared, deepens", async () => {
    const { steps, counts } = scripted({ verifies: [verif(0.9, { contradicted: 1 }), verif(0.8)], enrich: true });
    const r = await deepenToConfidence(steps, cfg(), { evidence: "e" });
    expect(r.trace.rounds[0].cleared).toBe(false);
    expect(counts.enrich).toBeGreaterThanOrEqual(1);
    expect(r.trace.cleared).toBe(true);
  });
});

const decide = (o: Partial<ManagerDecision>): ManagerDecision => ({ action: "reanalyze", verdict: null, escalate: false, focus: [], target_claims: [], rationale: "", ...o });
function fakeManager(decisions: ManagerDecision[]): { manager: DeskManager; calls: number[] } {
  const state = { i: 0 };
  const manager: DeskManager = { async decide() { return decisions[Math.min(state.i++, decisions.length - 1)]; } };
  return { manager, get calls() { return [state.i]; } };
}

describe("deepenToConfidence — manager mode", () => {
  it("manager drives an enrich then concludes confident -> cleared, driver=manager", async () => {
    const { steps } = scripted({ verifies: [verif(0.5), verif(0.7)], enrich: true });
    const { manager } = fakeManager([decide({ action: "enrich", focus: ["transcript"] }), decide({ action: "conclude", verdict: "confident" })]);
    const r = await deepenToConfidence({ ...steps, manager }, cfg(), { evidence: "e" });
    expect(r.trace.driver).toBe("manager");
    expect(r.trace.cleared).toBe(true);
    expect(r.trace.stopped_reason).toBe("cleared");
    expect(r.trace.manager_log?.map((m) => m.action)).toEqual(["enrich", "conclude"]);
  });

  it("manager concludes hold -> not cleared, stopped=manager_hold, recommendation review", async () => {
    const { steps } = scripted({ verifies: [verif(0.5)], enrich: true });
    const { manager } = fakeManager([decide({ action: "conclude", verdict: "hold" })]);
    const r = await deepenToConfidence({ ...steps, manager }, cfg(), { evidence: "e" });
    expect(r.trace.cleared).toBe(false);
    expect(r.trace.stopped_reason).toBe("manager_hold");
    expect(r.verification.recommendation).toBe("review");
  });

  it("manager 'confident' is overridden to NOT cleared while a contradicted claim stands", async () => {
    const { steps } = scripted({ verifies: [verif(0.9, { contradicted: 1 })] });
    const { manager } = fakeManager([decide({ action: "conclude", verdict: "confident" })]);
    const r = await deepenToConfidence({ ...steps, manager }, cfg(), { evidence: "e" });
    expect(r.trace.cleared).toBe(false); // hard safety: contradicted blocks publish regardless of the manager
  });

  it("manager never concludes -> forced final turn publishes a well-supported thesis by substance", async () => {
    // low float (0.6) but 6 supported vs 2 unverified, 0 contradicted -> substance says publishable
    const { steps } = scripted({ verifies: [verif(0.6, { supported: 6, unverified: 2 })] });
    // manager always reanalyzes (never concludes) and its final turn also returns no verdict
    const { manager } = fakeManager([decide({ action: "reanalyze", focus: ["x"] })]);
    const r = await deepenToConfidence({ ...steps, manager }, cfg(), { evidence: "e" });
    expect(r.trace.cleared).toBe(true); // forced-final fell back to publishableBySubstance
    expect(r.trace.manager_log?.[r.trace.manager_log.length - 1].action).toBe("conclude");
  });

  it("manager never concludes + weak substance (unverified majority) -> hold", async () => {
    const { steps } = scripted({ verifies: [verif(0.5, { supported: 1, unverified: 5 })] });
    const { manager } = fakeManager([decide({ action: "reanalyze", focus: ["x"] })]);
    const r = await deepenToConfidence({ ...steps, manager }, cfg(), { evidence: "e" });
    expect(r.trace.cleared).toBe(false);
    expect(r.trace.stopped_reason).toBe("manager_hold");
  });

  it("manager reanalyze with escalate reaches the top tier", async () => {
    const { steps } = scripted({ verifies: [verif(0.5), verif(0.9)] });
    const { manager } = fakeManager([decide({ action: "reanalyze", escalate: true, focus: ["margins"] }), decide({ action: "conclude", verdict: "confident" })]);
    const r = await deepenToConfidence({ ...steps, manager }, cfg(), { evidence: "e" });
    const reRound = r.trace.rounds.find((x) => x.lever === "bump_tier");
    expect(reRound?.tier).toBe(DESK_CONFIG.lensTierLadder[1]);
    expect(r.trace.cleared).toBe(true);
  });
});
