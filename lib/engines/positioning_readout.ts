/**
 * Positioning readout (control P12). Pure, deterministic (no RNG, no LLM): turn the model ratios, the
 * Monte Carlo scenario bands, the desk's price target and the current spot into three plain-language
 * artifacts the verdict box renders —
 *
 *   implied_assumptions — what spot is ALREADY pricing (a P/E on P50 EPS, the embedded growth, the GM
 *                         it leans on), so the reader sees the bar the thesis has to clear.
 *   fair_value          — scenario EPS P10/P50/P90 × an (illustrative) multiple, reconciled against the
 *                         stated price target, and flagged when the desk's LEAN contradicts the spread
 *                         (e.g. "constructive" but base fair value sits at or below spot).
 *   action_rules        — a rule for EVERY invalidation trigger (deterministic fallback), merging any
 *                         rule the desk authored.
 *
 * Degrades to null when spot / the scenario EPS band / the price target are missing — never fabricates.
 */
import { POSITIONING_CONFIG, type PositioningConfig } from "../config/positioning";

interface Band { p10: number; p50: number; p90: number }

export interface FairValueReadout {
  low: number | null;
  base: number | null;
  high: number | null;
  multiple: number | null;
  basis: string;
  consistent_with_lean: boolean;
  reconciliation: string;
}
export interface ActionRuleReadout { trigger: string; rule: string }
export interface PositioningReadout {
  implied_assumptions: string[];
  fair_value: FairValueReadout;
  action_rules: ActionRuleReadout[];
}

export interface PositioningReadoutInput {
  modelRatios: { gross_margin?: number | null; net_margin?: number | null };
  scenarioBands: { eps?: Band | null; revenue_growth?: Band | null } | null;
  priceTarget: { bear: number | null; base: number | null; bull: number | null } | null;
  spot: number | null;
  consensusMultiple?: number | null;
  lean?: string | null; // strategic_stance: strong_long | constructive | neutral | cautious | avoid
  invalidationTriggers: string[];
  actionRules?: Array<{ trigger: string; rule: string }>; // LLM-authored rules to merge
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function positioningReadout(
  input: PositioningReadoutInput,
  cfg: PositioningConfig = POSITIONING_CONFIG,
): PositioningReadout | null {
  const eps = input.scenarioBands?.eps ?? null;
  const spot = input.spot;
  const pt = input.priceTarget;
  // Degrade to null: without spot, a scenario EPS band, or a price target there is nothing to reconcile.
  if (spot == null || !eps || !pt || (pt.bear == null && pt.base == null && pt.bull == null)) return null;

  const multiple = input.consensusMultiple ?? cfg.defaultMultiple;
  const fvLow = round2(eps.p10 * multiple);
  const fvBase = round2(eps.p50 * multiple);
  const fvHigh = round2(eps.p90 * multiple);

  // Lean vs spread: a bullish lean should put base fair value clear of spot; a bearish lean, under it.
  const bullish = input.lean === "strong_long" || input.lean === "constructive";
  const bearish = input.lean === "avoid" || input.lean === "cautious";
  const tol = cfg.leanContradictionTolerance;
  let consistent = true;
  if (bullish) consistent = fvBase > spot * (1 + tol);
  else if (bearish) consistent = fvBase < spot * (1 - tol);

  const reconParts: string[] = [
    `Illustrative fair value $${fvBase} = P50 EPS $${eps.p50.toFixed(2)} × ${multiple}×.`,
  ];
  if (pt.base != null) {
    const rel = pt.base !== 0 ? (fvBase - pt.base) / Math.abs(pt.base) : 0;
    reconParts.push(Math.abs(rel) <= 0.1
      ? `In line with the stated base target $${round2(pt.base)}.`
      : `Diverges from the stated base target $${round2(pt.base)} (${rel > 0 ? "+" : ""}${(rel * 100).toFixed(0)}%).`);
  }
  if (!consistent) {
    reconParts.push(`Lean (${input.lean}) contradicts the spread: base fair value $${fvBase} is ${fvBase <= spot ? "at or below" : "above"} spot $${round2(spot)}.`);
  }
  const reconciliation = reconParts.join(" ");

  const implied: string[] = [];
  if (eps.p50 !== 0) implied.push(`Spot $${round2(spot)} prices ~${(spot / eps.p50).toFixed(1)}× P50 EPS ($${eps.p50.toFixed(2)}).`);
  const rg = input.scenarioBands?.revenue_growth;
  if (rg) implied.push(`Base case embeds ~${(rg.p50 * 100).toFixed(0)}% revenue growth (P10/P90 ${(rg.p10 * 100).toFixed(0)}/${(rg.p90 * 100).toFixed(0)}%).`);
  const gm = input.modelRatios.gross_margin;
  if (gm != null) {
    implied.push(gm >= cfg.highGrossMarginThreshold
      ? `Sustaining spot leans on gross margin holding above ${(cfg.highGrossMarginThreshold * 100).toFixed(0)}% (currently ${(gm * 100).toFixed(0)}%).`
      : `Gross margin is ${(gm * 100).toFixed(0)}% — spot needs it defended.`);
  }

  // Every invalidation trigger gets a rule; merge the desk's authored rules where they exist.
  const authored = new Map((input.actionRules ?? []).map((r) => [r.trigger, r.rule] as const));
  const rules: ActionRuleReadout[] = [];
  const seen = new Set<string>();
  for (const trig of input.invalidationTriggers) {
    rules.push({ trigger: trig, rule: authored.get(trig) ?? cfg.defaultActionRule });
    seen.add(trig);
  }
  for (const [trigger, rule] of authored) {
    if (!seen.has(trigger)) rules.push({ trigger, rule });
  }

  return {
    implied_assumptions: implied,
    fair_value: { low: fvLow, base: fvBase, high: fvHigh, multiple, basis: cfg.illustrativeLabel, consistent_with_lean: consistent, reconciliation },
    action_rules: rules,
  };
}
