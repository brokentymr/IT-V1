/**
 * Positioning / decision engine (pipeline upgrade — docs/UPGRADE-report-positioning.md).
 *
 * The Micron report DESCRIBED; it never DECIDED — no rating, no target, no sizing, empty catalysts,
 * conviction 2/5, and its one real insight buried. This stage converts the desk's adjudicated research
 * into an actual POSITIONING DECISION: a stance, a variant view (or an honest "no edge — pass"), a
 * price-target range tied to the scenario, dated catalysts, sizing, and the invalidation triggers. It
 * is what makes a report answer "what do I do?"
 */
import { z } from "zod";
import { completeJSON } from "../llm/client";

export const Catalyst = z.object({
  event: z.string(),
  date: z.string().nullable().default(null),
  expected_direction: z.enum(["positive", "negative", "mixed", "unclear"]).default("unclear"),
  why: z.string().default(""),
});
export type Catalyst = z.infer<typeof Catalyst>;

export const PriceTarget = z.object({
  bear: z.number().nullable().default(null),
  base: z.number().nullable().default(null),
  bull: z.number().nullable().default(null),
});

export const STANCES = ["strong_long", "constructive", "neutral", "cautious", "avoid"] as const;

// Control P12: the deterministic positioning readout, merged onto the decision before it is written to
// the snapshot. Optional/defaulted so a bare LLM decision (tests/positioning.test.ts) still parses.
export const FairValue = z.object({
  low: z.number().nullable().default(null),
  base: z.number().nullable().default(null),
  high: z.number().nullable().default(null),
  multiple: z.number().nullable().default(null),
  basis: z.string().default(""),
  consistent_with_lean: z.boolean().default(true),
  reconciliation: z.string().default(""),
});
export type FairValue = z.infer<typeof FairValue>;
export const ActionRule = z.object({ trigger: z.string(), rule: z.string() });
export type ActionRule = z.infer<typeof ActionRule>;

export const PositioningDecision = z.object({
  strategic_stance: z.enum(STANCES),
  tactical_stance: z.string().default(""), // e.g. "trim into the print", "add on weakness", "wait for the catalyst"
  conviction: z.number().int().min(1).max(5),
  conviction_basis: z.string().default(""),
  // Mandatory: the edge, or an explicit declaration that there is none. This is the quality gate.
  variant_view: z.string(),
  is_consensus: z.boolean().default(false), // true = we ARE consensus / no differentiated edge → pass
  price_target: PriceTarget.default({ bear: null, base: null, bull: null }),
  expected_return_pct: z.number().nullable().default(null),
  risk_reward: z.string().default(""), // e.g. "1 : 1.8"
  horizon: z.string().default(""),
  sizing_guidance: z.string().default(""),
  catalysts: z.array(Catalyst).default([]),
  invalidation_triggers: z.array(z.string()).default([]),
  // Control P12: readout (computed deterministically in the coverage pass, merged in after decide()).
  implied_assumptions: z.array(z.string()).default([]),
  fair_value: FairValue.nullable().default(null),
  action_rules: z.array(ActionRule).default([]),
});
export type PositioningDecision = z.infer<typeof PositioningDecision>;

export interface PositioningInput {
  company: { legal_name: string; ticker: string | null; listing: string };
  thesis: {
    one_liner: string;
    long_form: string;
    conviction: number;
    key_debates?: Array<{ question: string; bull: string; bear: string; lean: string }>;
    invalidation_triggers?: string[];
  };
  verification: { confidence: number; grounded_coverage: number };
  scenario_summary: string;
  market_context?: string;
  next_earnings_date?: string | null;
}

export interface PositioningDesk {
  decide(input: PositioningInput): Promise<PositioningDecision>;
}

export class ClaudePositioningDesk implements PositioningDesk {
  constructor(private readonly model = "claude-opus-4-8") {}

  async decide(input: PositioningInput): Promise<PositioningDecision> {
    const debates = (input.thesis.key_debates ?? []).map((d) => `- ${d.question} | bull: ${d.bull} | bear: ${d.bear} | desk lean: ${d.lean}`).join("\n") || "(none stated)";
    const prompt = `You are a portfolio manager. Convert the desk's research into a POSITIONING DECISION a PM can act on.
Do NOT hedge into mush ("high-reward, high-variance") — COMMIT to a call and justify it.

Rules:
- Take a stance: strong_long | constructive | neutral | cautious | avoid.
- Give the VARIANT VIEW: what you believe that consensus does NOT, and the edge, tied to the evidence.
  If you have no differentiated view, set "is_consensus": true, stance "neutral", and say so plainly
  (e.g. "no edge — pass; priced for the base case"). A clear pass is a valid, valuable answer; a
  decision-free hedge is not.
- Price target {bear, base, bull} tied to the scenario bands and consensus multiples; null if not derivable.
- Extract DATED catalysts — events that move the thesis (next earnings, product/qual milestones,
  policy decisions). Use the next earnings date. Never leave catalysts empty for a covered name.
- Give conviction (1-5) with a one-line basis, a risk/reward (e.g. "1 : 1.8"), a horizon, and sizing
  guidance appropriate to the variance.
- Fold in the desk's invalidation triggers.

Company: ${input.company.legal_name} (${input.company.ticker ?? "unlisted"}) — ${input.company.listing}
Next earnings: ${input.next_earnings_date ?? "unknown"}
House thesis: ${input.thesis.one_liner}
${input.thesis.long_form}
Desk conviction: ${input.thesis.conviction}/5 · verification confidence ${(input.verification.confidence * 100).toFixed(0)}% · grounded coverage ${(input.verification.grounded_coverage * 100).toFixed(0)}%
Key debates (already adjudicated by the desk):
${debates}
Scenario: ${input.scenario_summary}
${input.market_context ? `Market context: ${input.market_context}` : ""}

Return JSON:
{"strategic_stance": "strong_long|constructive|neutral|cautious|avoid", "tactical_stance": string,
 "conviction": int 1-5, "conviction_basis": string, "variant_view": string, "is_consensus": boolean,
 "price_target": {"bear": number|null, "base": number|null, "bull": number|null},
 "expected_return_pct": number|null, "risk_reward": string, "horizon": string, "sizing_guidance": string,
 "catalysts": [{"event": string, "date": string|null, "expected_direction": "positive|negative|mixed|unclear", "why": string}],
 "invalidation_triggers": [string]}`;
    return completeJSON({ prompt, schema: PositioningDecision, model: this.model, purpose: "research.positioning", maxTokens: 2200 });
  }
}

/**
 * Publish gate (Doc 2 §6): "description-only is unpublishable." A covered name may auto-publish only
 * with a real stance, a variant view (or an explicit consensus/pass), and catalysts to watch. A
 * decision-free artifact is held for the human checkpoint.
 */
export function positioningComplete(d: PositioningDecision): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!d.variant_view.trim()) missing.push("variant_view");
  if (!d.catalysts.length) missing.push("catalysts");
  return { complete: missing.length === 0, missing };
}
