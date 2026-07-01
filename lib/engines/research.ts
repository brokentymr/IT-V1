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
import { completeJSON, CostCeilingError } from "../llm/client";
import { RESOLUTION_VERDICTS } from "./areas_of_interest";
import { deepenToConfidence, type DeepenSteps, type DeepeningTrace } from "./deepen";
import { ClaudeDeskManager } from "./desk_manager";
import { DESK_CONFIG, type DeskConfig } from "../config/desk";

const LENS = z.enum(["equity", "sector", "technology", "risk"]);

// Tolerant 0-1 confidence: models variously emit 0.85, 85 (percent), or "0.85". Normalize them.
const Confidence = z.coerce.number().transform((n) => (n > 1 ? Math.min(1, n / 100) : Math.max(0, Math.min(1, n))));

export const ExpertContribution = z.object({
  lens: LENS,
  summary: z.string(),
  key_points: z.array(z.string()).default([]),
  claims: z.array(z.object({ statement: z.string(), basis: z.string(), confidence: Confidence })).default([]),
  risks: z.array(z.string()).default([]),
  confidence: Confidence,
});
export type ExpertContribution = z.infer<typeof ExpertContribution>;

export const ThesisSynthesis = z.object({
  one_liner: z.string(),
  long_form: z.string(),
  actual_vs_expected: z.string().default(""),
  tensions: z.array(z.string()).default([]),
  invalidation_triggers: z.array(z.string()).min(1),
  conviction: z.number().int().min(1).max(5),
  claims_to_verify: z.array(z.string()).default([]),
});
export type ThesisSynthesis = z.infer<typeof ThesisSynthesis>;

export const VerificationResult = z.object({
  verdicts: z.array(z.object({ claim: z.string(), status: z.enum(["supported", "unverified", "contradicted"]), note: z.string() })).default([]),
  confidence: Confidence,
  missing_sources: z.array(z.string()).default([]),
  recommendation: z.enum(["auto", "review"]),
});
export type VerificationResult = z.infer<typeof VerificationResult>;

/** Source-gap fill on the wired sources, supplied by the caller (coverage wires EDGAR + Perplexity).
 *  Absent in tests/onboarding, in which case the deepening loop re-lenses/bumps tier without new evidence. */
export type ResearchEnrich = (input: { missing: string[]; unverified: string[] }) => Promise<{ appended: string; sources: string[] } | null>;

export interface ResearchContext {
  company: { legal_name: string; ticker: string | null; gics_sector: string | null; listing: string };
  evidence: string; // assembled by the caller: figures, drivers, scenario, consensus, profile, news
  rolling_outlook?: string;
  forward_expectations?: string | null;
  research_focus?: string[];
  enrich?: ResearchEnrich;
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
    return { panel, thesis, verification, deepening: trace };
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
5 key_points, 5 claims, 5 risks. For each material CLAIM give the basis and a confidence in [0,1]. JSON:
{"lens": "${lens}", "summary": string, "key_points": [string],
 "claims": [{"statement": string, "basis": string, "confidence": number}],
 "risks": [string], "confidence": number}`;
    return completeJSON({ prompt, schema: ExpertContribution, model: tier, purpose: `research.lens.${lens}`, maxTokens: 1800 });
  }

  private synthesize(panel: ExpertContribution[], block: string, focus?: string[]): Promise<ThesisSynthesis> {
    const panelText = panel.map((p) => `### ${p.lens} (confidence ${p.confidence})\n${p.summary}\nKey: ${p.key_points.join("; ")}\nRisks: ${p.risks.join("; ")}`).join("\n\n");
    const prompt = `You are the head of research. Synthesize the desk's panel into the house view — reconcile disagreements, do not just average. Keep long_form to ~5 sentences; each list to at most 5 short items. The invalidation triggers MUST be specific and measurable. List the load-bearing factual CLAIMS (at most 8) that should be fact-checked before publishing.${focusNote(focus)}

${block}

Panel:
${panelText}

Return JSON:
{"one_liner": string, "long_form": string, "actual_vs_expected": string, "tensions": [string],
 "invalidation_triggers": [string], "conviction": int 1-5, "claims_to_verify": [string]}`;
    return completeJSON({ prompt, schema: ThesisSynthesis, model: this.cfg.synthModel, purpose: "research.synthesis", maxTokens: 2600 });
  }

  private verify(thesis: ThesisSynthesis, panel: ExpertContribution[], block: string): Promise<VerificationResult> {
    const claims = [...new Set([...thesis.claims_to_verify, ...panel.flatMap((p) => p.claims.map((c) => c.statement))])].slice(0, 12);
    const prompt = `You are a skeptical fact-checker and devil's advocate. For EACH claim below, judge it ONLY against the evidence provided: "supported" (the evidence backs it), "unverified" (plausible but the evidence here doesn't establish it), or "contradicted" (the evidence cuts against it). Do not be generous — default to "unverified" when the evidence is silent. Then give an overall confidence (0-1) in the thesis, list what additional sources are MISSING to raise confidence, and recommend "auto" only if confidence is high AND nothing is contradicted, else "review".

${block}

Thesis: ${thesis.one_liner} — ${thesis.long_form}

Claims:
${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Return JSON:
{"verdicts": [{"claim": string, "status": "supported|unverified|contradicted", "note": string}],
 "confidence": number, "missing_sources": [string], "recommendation": "auto|review"}`;
    return completeJSON({ prompt, schema: VerificationResult, model: this.cfg.verifyModel, purpose: "research.verify", maxTokens: 3000 });
  }
}
