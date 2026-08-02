/**
 * The analyst desk (reliability hardening, 2026-06-30). Tier-one research is multi-perspective,
 * synthesized, and adversarially checked — not one generalist LLM call. This runs a panel of
 * specialist lenses, has a head-of-research synthesize the house thesis, then a skeptic tries to
 * REFUTE the load-bearing claims and scores confidence + missing sources (operationalizes spec §8:
 * low confidence blocks auto-publish and routes to the human checkpoint).
 *
 * Model tiering (owner decision 2026-06-30): Sonnet for the expert lenses, Opus for synthesis and
 * adversarial verification. Injectable so the engines stay deterministic in tests.
 */
import { z } from "zod";
import { Risk, InvalidationTrigger } from "../types";
import { completeJSON, CostCeilingError } from "../llm/client";
import { RESOLUTION_VERDICTS } from "./areas_of_interest";
import { deepenToConfidence, publishableBySubstance, type DeepenSteps, type DeepeningTrace } from "./deepen";
import { ClaudeDeskManager } from "./desk_manager";
import { claimsDigest, divergenceNote } from "./adjudication";
import { DESK_CONFIG, type DeskConfig } from "../config/desk";

const LENS = z.enum(["equity", "sector", "technology", "risk"]);

// Tolerant 0-1 confidence: models variously emit 0.85, 85 (percent), or "0.85". Normalize them.
const Confidence = z.coerce.number().transform((n) => (n > 1 ? Math.min(1, n / 100) : Math.max(0, Math.min(1, n))));

export const ExpertContribution = z.object({
  lens: LENS,
  summary: z.string(),
  key_points: z.array(z.string()).default([]),
  claims: z.array(z.object({ statement: z.string(), basis: z.string(), grounded: z.boolean().default(false), confidence: Confidence })).default([]),
  risks: z.array(z.string()).default([]),
  confidence: Confidence,
});
export type ExpertContribution = z.infer<typeof ExpertContribution>;

export const KeyDebate = z.object({
  question: z.string(),
  bull: z.string().default(""),
  bear: z.string().default(""),
  lean: z.string().default(""), // the desk's adjudicated lean + why
});
export type KeyDebate = z.infer<typeof KeyDebate>;

export const ThesisSynthesis = z.object({
  one_liner: z.string(),
  long_form: z.string(),
  actual_vs_expected: z.string().default(""),
  tensions: z.array(z.string()).default([]),
  // The load-bearing questions the thesis rests on, each OWNED with a bull/bear and the desk's lean —
  // this is where lens disagreement is adjudicated instead of averaged (pipeline upgrade §4).
  key_debates: z.array(KeyDebate).default([]),
  invalidation_triggers: z.array(z.string()).min(1),
  // Control P10: risks & triggers as one typed, joined system — each risk names its mechanism/severity
  // and points at the trigger that would confirm it; each trigger carries a verifiable disclosure.
  // (The legacy string[] invalidation_triggers above is kept for backward compat.)
  risks: z.array(Risk).default([]),
  triggers: z.array(InvalidationTrigger).default([]),
  conviction: z.number().int().min(1).max(5),
  claims_to_verify: z.array(z.string()).default([]),
});
export type ThesisSynthesis = z.infer<typeof ThesisSynthesis>;

export const VerificationResult = z.object({
  // W4: a "supported" verdict must cite the specific figure/passage from the evidence that backs it.
  // `unverifiable` (set by the coverage-closer, never the model) = tried against filing + external and
  // unsourceable → dropped from the grounded-coverage denominator and surfaced as an explicit gap.
  verdicts: z.array(z.object({ claim: z.string(), status: z.enum(["supported", "unverified", "contradicted"]), note: z.string(), citation: z.string().default(""), unverifiable: z.boolean().optional() })).default([]),
  confidence: Confidence,
  missing_sources: z.array(z.string()).default([]),
  recommendation: z.enum(["auto", "review"]),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

/** Source-gap fill on the wired sources, supplied by the caller (coverage wires EDGAR + Perplexity).
 *  Absent in tests/onboarding, in which case the deepening loop re-lenses/bumps tier without new evidence. */
export type ResearchEnrich = (input: { missing: string[]; unverified: string[] }) => Promise<{ appended: string; sources: string[] } | null>;

/** Per-claim citation binding for the coverage-closer, supplied by the caller (coverage wires the filing
 *  text + Perplexity). Given the unverified load-bearing claims, returns each bound to a citation or
 *  flagged unverifiable. Absent in tests → the coverage-closer no-ops. */
export type ResearchBind = (claims: string[]) => Promise<Array<{ claim: string; status: "supported" | "unverifiable"; citation: string; source: string }>>;

export interface ResearchContext {
  company: { legal_name: string; ticker: string | null; gics_sector: string | null; listing: string };
  evidence: string; // assembled by the caller: figures, drivers, scenario, consensus, profile, news
  rolling_outlook?: string;
  forward_expectations?: string | null;
  research_focus?: string[];
  enrich?: ResearchEnrich;
  bind?: ResearchBind;
  /** Per-asset budget gate checked between deepening rounds (coverage wires it to the LLM ledger). */
  withinBudget?: () => Promise<boolean>;
}

export interface ResearchResult {
  panel: ExpertContribution[];
  thesis: ThesisSynthesis;
  verification: VerificationResult;
  deepening?: DeepeningTrace; // Workstream C: the escalation trace (absent when the injected fake panel is used)
}

export const AreaResolution = z.object({
  theme: z.string(),
  verdict: z.enum(RESOLUTION_VERDICTS),
  note: z.string(),
});
export type AreaResolution = z.infer<typeof AreaResolution>;

export const AreaAdjudication = z.object({ resolutions: z.array(AreaResolution).default([]) });
export type AreaAdjudication = z.infer<typeof AreaAdjudication>;

export interface AdjudicateInput {
  company: { legal_name: string; ticker: string | null };
  thesis: ThesisSynthesis;
  evidence: string;
  areas: Array<{ theme: string; title: string; summary: string; mentions: number }>;
}

export interface ResearchPanel {
  runResearch(ctx: ResearchContext): Promise<ResearchResult>;
  /** Adjudicate the open areas of interest now that this filing's analysis is in (Phase 5.5).
   *  Optional so existing fakes/implementations keep working; the coverage pass skips when absent. */
  adjudicateAreas?(input: AdjudicateInput): Promise<AreaAdjudication>;
}

const focusNote = (focus?: string[]): string =>
  focus?.length
    ? `\n\nGive EXTRA WEIGHT to (without narrowing — keep full breadth): ${focus.map((f) => `"${f}"`).join(", ")}.`
    : "";

const LENSES: Record<z.infer<typeof LENS>, { persona: string; brief: string }> = {
  equity: {
    persona: "a tier-one buy-side equity analyst",
    brief: "Assess fundamentals and earnings quality, valuation vs. the figures, capital allocation, balance-sheet health. Tie every point to a number where you can.",
  },
  sector: {
    persona: "a sector strategist and competitive-dynamics expert",
    brief: "Assess competitive position, market share, the value chain (suppliers/customers/substitutes), and supply-demand. Name specific competitors and where this company sits versus them.",
  },
  technology: {
    persona: "a technology and product expert for this sector",
    brief: "Assess product depth, roadmap, the durability of the moat, and disruption / substitution risk (including in-house or emerging-player threats). Be concrete about the technology.",
  },
  risk: {
    persona: "a skeptical risk officer / short-seller building the bear case",
    brief: "Build the strongest case AGAINST. Identify what would break the thesis, tail risks, governance, regulatory, accounting red flags. Be specific and measurable.",
  },
};

function contextBlock(ctx: ResearchContext): string {
  const c = ctx.company;
  return `Company: ${c.legal_name} (${c.ticker ?? "unlisted"}) — sector ${c.gics_sector ?? "unknown"}, ${c.listing}.
Rolling outlook: ${ctx.rolling_outlook || "(none)"}
Forward expectations staged: ${ctx.forward_expectations ?? "(none)"}

Evidence:
${ctx.evidence}`;
}

export class ClaudeResearchPanel implements ResearchPanel {
  constructor(private readonly opts: { config?: DeskConfig } = {}) {}
  private get cfg(): DeskConfig { return this.opts.config ?? DESK_CONFIG; }

  async runResearch(ctx: ResearchContext): Promise<ResearchResult> {
    // The desk is now a deepening loop (Workstream C): round 0 is the historical single pass
    // (Sonnet lenses -> Opus synthesis -> Opus adversarial verify); if it's short of the bar the
    // orchestrator escalates on the wired sources. All side-effects are injected as steps.
    const steps: DeepenSteps = {
      runPanel: (evidence, tier, focus) => this.runLensPanel(evidence, tier, focus ?? ctx.research_focus),
      synthesize: (panel, evidence) => this.synthesize(panel, evidence, ctx.research_focus),
      verify: (thesis, panel, evidence) => this.verify(thesis, panel, evidence),
      ...(ctx.enrich ? { enrich: (i) => ctx.enrich!(i) } : {}),
      ...(ctx.withinBudget ? { withinBudget: ctx.withinBudget } : {}),
      ...(this.cfg.managerEnabled ? { manager: new ClaudeDeskManager(this.cfg.managerModel) } : {}),
    };
    const { panel, thesis, verification, trace } = await deepenToConfidence(steps, this.cfg, {
      company: { legal_name: ctx.company.legal_name, ticker: ctx.company.ticker },
      evidence: contextBlock(ctx), focus: ctx.research_focus,
    });

    // Coverage-closer (grounding as a first-class target): the confidence loop above optimizes CONFIDENCE;
    // it can settle with grounded coverage still under the bar because most load-bearing claims lack an
    // explicit citation. Here we agentically BIND each unverified claim to a specific source — filing
    // first, then a targeted external query — until coverage clears or every claim has been tried. This
    // is what makes grounding reliable rather than a post-hoc gate the loop never aimed at.
    if (this.cfg.coverageBindingEnabled && ctx.bind) {
      await this.closeCoverage(verification, trace, ctx.bind);
    }
    return { panel, thesis, verification, deepening: trace };
  }

  /** Drive grounded coverage up to the bar by binding each unverified load-bearing claim to a citation.
   *  Mutates `verification.verdicts` in place: a bound claim becomes supported+citation; a claim tried and
   *  unsourceable is flagged `unverifiable` (dropped from the coverage denominator, surfaced as a gap).
   *  Loops up to `coverageMaxBindRounds`, stopping early once coverage clears or a round binds nothing new.
   *  Then re-decides publishability on the now-grounded artifact: a thesis with NO contradictions whose
   *  supported claims clear the coverage bar and outnumber the unverified is publishable by substance —
   *  so grounding work can rescue a hold that was only ever a coverage/confidence-float shortfall. The hard
   *  contradiction block is never relaxed, and a cleared artifact is never downgraded here. */
  private async closeCoverage(verification: VerificationResult, trace: DeepeningTrace, bind: ResearchBind): Promise<void> {
    const counted = () => verification.verdicts.filter((v) => !v.unverifiable);
    const coverage = (): number => {
      const c = counted();
      const supported = c.filter((v) => v.status === "supported" && v.citation.trim()).length;
      return c.length ? supported / c.length : 1;
    };
    for (let round = 0; round < this.cfg.coverageMaxBindRounds; round++) {
      // Bind toward the TARGET (not the publish gate): cite every claim we can, even on a run that already
      // clears the gate, so published claims carry real citations. The gate stays separate, below.
      if (coverage() >= this.cfg.coverageBindTarget) break;
      const open = verification.verdicts.filter((v) => v.status === "unverified" && !v.unverifiable);
      if (!open.length) break;
      let results: Awaited<ReturnType<ResearchBind>>;
      try {
        results = await bind(open.map((v) => v.claim));
      } catch (e) {
        console.warn(`[research] coverage-closer bind failed: ${(e as Error).message}`);
        break;
      }
      const byClaim = new Map(results.map((r) => [r.claim, r]));
      let boundNew = 0;
      for (const v of open) {
        const r = byClaim.get(v.claim);
        if (!r) continue;
        if (r.status === "supported" && r.citation.trim()) {
          v.status = "supported"; v.citation = r.citation; v.note = v.note || "bound by coverage-closer"; boundNew++;
        } else {
          v.unverifiable = true; v.note = `${v.note} [unverifiable: ${r.source}]`.trim();
        }
      }
      const total = counted().length;
      const supported = counted().filter((v) => v.status === "supported" && v.citation.trim()).length;
      console.log(`[research] coverage-closer round ${round}: bound ${boundNew}, coverage ${(coverage() * 100).toFixed(0)}% (${supported}/${total})`);
      if (boundNew === 0) break; // nothing more this source can bind — remaining opens are now unverifiable
    }

    // Re-decide on the grounded artifact. Only ever UPGRADE review → auto (binding can't make things worse),
    // and only when the artifact is genuinely publishable by substance AND clears the coverage GATE (not the
    // higher bind target) AND isn't resting on too many unsourceable claims (the integrity cap — see below).
    const all = verification.verdicts.length;
    const unver = verification.verdicts.filter((v) => v.unverifiable).length;
    const tooManyGaps = all > 0 && unver / all > this.cfg.maxUnverifiableFraction;
    if (!trace.cleared
        && !tooManyGaps
        && coverage() >= this.cfg.minGroundedCoverage
        && publishableBySubstance(verification, this.cfg)) {
      trace.cleared = true;
      trace.stopped_reason = "cleared";
      verification.recommendation = "auto";
      console.log(`[research] coverage-closer: grounded artifact now clears (coverage ${(coverage() * 100).toFixed(0)}%, no contradictions) — recommend auto`);
    } else if (tooManyGaps) {
      console.log(`[research] coverage-closer: ${unver}/${all} claims unverifiable (> ${(this.cfg.maxUnverifiableFraction * 100).toFixed(0)}% cap) — holding for review`);
    }
  }

  /** The parallel expert lenses at a given model tier. A CostCeilingError fails the panel fast
   *  (rethrown) so the deepening loop can stop cleanly rather than silently degrading and still
   *  billing the two Opus calls; any other lens failure degrades to a dropped lens. */
  private runLensPanel(block: string, tier: string, focus?: string[]): Promise<ExpertContribution[]> {
    return Promise.all(
      (Object.keys(LENSES) as Array<z.infer<typeof LENS>>).map((lens) =>
        this.runLens(lens, block, tier, focus).catch((e) => {
          if (e instanceof CostCeilingError) throw e;
          console.warn(`[research] lens ${lens} failed: ${(e as Error).message}`);
          return null;
        })),
    ).then((xs) => xs.filter((x): x is ExpertContribution => x !== null));
  }

  async adjudicateAreas(input: AdjudicateInput): Promise<AreaAdjudication> {
    if (!input.areas.length) return { resolutions: [] };
    const areaList = input.areas
      .map((a, i) => `${i + 1}. [${a.theme}] ${a.title}${a.mentions > 1 ? ` (×${a.mentions} headlines)` : ""}${a.summary ? ` — ${a.summary}` : ""}`)
      .join("\n");
    const prompt = `You are the head of research adjudicating OPEN AREAS OF INTEREST — material developments that
accumulated from the headlines between filings — now that this filing's analysis is in. For EACH area,
decide against the evidence and the house thesis:
- "invalidated": the feared worst case (or hoped best case) is ruled out by the filing — the concern will NOT
  materialize as the street feared. Resolve.
- "confirmed": the development materialized and bears on the thesis. Resolve.
- "overreaction": a nothing-burger — the market/street overreacted; no lasting thesis impact. Resolve.
- "carry_forward": not yet conclusive; revisit next quarter before putting it to bed.
- "leave_open": this filing does not speak to it at all.
Ground each verdict in one sentence tied to the evidence. Be willing to call an overreaction when the numbers
do not support the narrative.

Company: ${input.company.legal_name} (${input.company.ticker ?? "unlisted"})
House thesis: ${input.thesis.one_liner} — ${input.thesis.long_form}
${input.thesis.actual_vs_expected ? `Actual vs expected: ${input.thesis.actual_vs_expected}` : ""}

Evidence:
${input.evidence}

Open areas of interest:
${areaList}

Return JSON: {"resolutions": [{"theme": string, "verdict": "invalidated|confirmed|overreaction|carry_forward|leave_open", "note": string}]}`;
    return completeJSON({ prompt, schema: AreaAdjudication, model: "claude-sonnet-4-6", purpose: "research.adjudicate_areas", maxTokens: 1500 });
  }

  private runLens(lens: z.infer<typeof LENS>, block: string, tier: string, focus?: string[]): Promise<ExpertContribution> {
    const { persona, brief } = LENSES[lens];
    const prompt = `You are ${persona}. ${brief}${focusNote(focus)}

${block}

Return your contribution as JSON — be specific, do not pad. Keep summary to 2-3 sentences; at most
5 key_points, 5 claims, 5 risks. For each material CLAIM give the basis and a confidence in [0,1], and
set "grounded": true ONLY if the basis is actually stated in the Evidence above — set it false when the
claim rests on your own background knowledge (an analyst prior to be verified, not a sourced fact).
Do not present a prior as if it were grounded. JSON:
{"lens": "${lens}", "summary": string, "key_points": [string],
 "claims": [{"statement": string, "basis": string, "grounded": boolean, "confidence": number}],
 "risks": [string], "confidence": number}`;
    // 3000, not 1800: lens JSON (summary + up to 5 claims each with statement/basis/grounded/confidence
    // + key_points + risks) was truncating at the ceiling, so the JSON failed to parse and the whole
    // lens was silently dropped — non-deterministically thinning the panel (4 lenses → A, 2 → F).
    return completeJSON({ prompt, schema: ExpertContribution, model: tier, purpose: `research.lens.${lens}`, maxTokens: 4000 });
  }

  private synthesize(panel: ExpertContribution[], block: string, focus?: string[]): Promise<ThesisSynthesis> {
    const panelText = panel.map((p) => `### ${p.lens} (confidence ${p.confidence})\n${p.summary}\nKey: ${p.key_points.join("; ")}\nRisks: ${p.risks.join("; ")}`).join("\n\n");
    // Adjudication (pipeline upgrade §4): show the synthesizer the per-lens claims (grounded vs prior)
    // and, when the lenses disagree materially, force it to RULE rather than average.
    const digest = claimsDigest(panel);
    const divergence = divergenceNote(panel);
    const prompt = `You are the head of research. Synthesize the desk's panel into the house view. Your job is to ADJUDICATE, not average: where the lenses disagree, rule on it. A dispute over a FACT (is a figure real, what is the share) is settled against the evidence — decide and say which lens is right. A dispute over JUDGMENT (is a margin durable) is OWNED as a key_debate with the bull case, the bear case, and your lean. Rely on GROUNDED claims for the confident thesis; treat "prior" claims as unverified and put them in claims_to_verify rather than the thesis. Keep long_form to ~5 sentences; each list to at most 5 short items; at most 3 key_debates. Invalidation triggers MUST be specific and measurable.

Then express risks and triggers as ONE JOINED SYSTEM. For "risks": each is a distinct downside with a short id ("r1","r2",...), a title, the MECHANISM by which it hurts the thesis, an optional quantified_impact (e.g. "−300bps gross margin", or null), a severity of "low"|"medium"|"high", and a linked_trigger_id pointing at the trigger below that would confirm it (or null). For "triggers": each has a short id ("t1","t2",...), the measurable condition, and a DISCLOSURE — the specific, verifiable observation to look for (e.g. "10-Q segment revenue for Data Center declines QoQ", "management withdraws FY guidance on the earnings call"). Every risk that can be confirmed should link to a trigger, and every trigger should be linked from a risk and carry a disclosure.${divergence ? `\n\n${divergence}` : ""}${focusNote(focus)}

${block}

Panel:
${panelText}

Per-lens claims (grounded = backed by the evidence above; prior = the lens's own background knowledge):
${digest}

Return JSON:
{"one_liner": string, "long_form": string, "actual_vs_expected": string, "tensions": [string],
 "key_debates": [{"question": string, "bull": string, "bear": string, "lean": string}],
 "invalidation_triggers": [string],
 "risks": [{"id": string, "title": string, "mechanism": string, "quantified_impact": string|null, "severity": "low|medium|high", "linked_trigger_id": string|null}],
 "triggers": [{"id": string, "condition": string, "disclosure": string, "source_ref": null}],
 "conviction": int 1-5, "claims_to_verify": [string]}`;
    // maxTokens raised (was 3000): control P10 added the typed risks[] + triggers[] arrays to this
    // response on top of the legacy fields, and 3000 truncated the JSON mid-array (parse failure).
    return completeJSON({ prompt, schema: ThesisSynthesis, model: this.cfg.synthModel, purpose: "research.synthesis", maxTokens: 6000 });
  }

  private verify(thesis: ThesisSynthesis, panel: ExpertContribution[], block: string): Promise<VerificationResult> {
    const claims = [...new Set([...thesis.claims_to_verify, ...panel.flatMap((p) => p.claims.map((c) => c.statement))])].slice(0, 12);
    const prompt = `You are a skeptical fact-checker and devil's advocate. For EACH claim below, judge it ONLY against the evidence provided: "supported" (the evidence backs it), "unverified" (plausible but the evidence here doesn't establish it), or "contradicted" (the evidence cuts against it). Do not be generous — default to "unverified" when the evidence is silent. A verdict may be "supported" ONLY if you can cite the specific figure, line, or passage from the evidence that backs it — put that exact citation in the "citation" field (e.g. "XBRL: gross margin 84.6%", "Demand & supply: NVIDIA take-or-pay", "customer capex +30%"). No citation → it is "unverified", not "supported". Then give an overall confidence (0-1), list what additional sources are MISSING to raise confidence, and recommend "auto" only if confidence is high AND nothing is contradicted, else "review".

${block}

Thesis: ${thesis.one_liner} — ${thesis.long_form}

Claims:
${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Return JSON:
{"verdicts": [{"claim": string, "status": "supported|unverified|contradicted", "note": string, "citation": string}],
 "confidence": number, "missing_sources": [string], "recommendation": "auto|review"}`;
    // maxTokens raised (was 3000): a richer, more grounded thesis yields more verdicts, truncating the
    // verdicts array at 3000 (parse failure). Verify must have room to rule on every load-bearing claim.
    return completeJSON({ prompt, schema: VerificationResult, model: this.cfg.verifyModel, purpose: "research.verify", maxTokens: 6000 });
  }
}
