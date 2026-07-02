/**
 * P(beat) divergence (control P7). Pure. The Monte Carlo scenario emits a model-implied probability of
 * beating consensus revenue next quarter; the company's OWN trailing record emits a historical "beat
 * rate" — the fraction of trailing quarterly YoY revenue growths that were positive. A model that
 * implies a near-certain beat against a company that has topped year-ago revenue only rarely (or the
 * reverse) is a divergence worth flagging. This module computes the trailing rate and, when the two
 * diverge beyond the configured threshold, renders ONE sentence explicitly labeled a momentum PROXY
 * (never a forecast). Never fabricates: too little history -> null rate -> no note.
 */
import type { CompanyFacts } from "../sources/sec";
import { metricYoYGrowths, type FinancialModel } from "./model";
import type { ScenarioOutput } from "./montecarlo";
import type { PbeatConfig } from "../config/fundamentals";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig } from "../config/fundamentals";

/**
 * Fraction of trailing quarterly YoY revenue growths that are positive (a "beat rate" proxy). Null when
 * fewer than `cfg.minHistoryPeriods` observations exist — a rate from two quarters is not a rate.
 */
export function trailingBeatRate(
  facts: CompanyFacts,
  cfg: PbeatConfig,
  fconfig: FundamentalsConfig = FUNDAMENTALS_CONFIG,
): number | null {
  const growths = metricYoYGrowths(facts, "revenue", fconfig);
  if (growths.length < cfg.minHistoryPeriods) return null;
  const positive = growths.filter((g) => g > 0).length;
  return positive / growths.length;
}

/**
 * One-sentence momentum-PROXY note when the model-implied P(beat consensus) diverges from the trailing
 * beat rate by more than `cfg.thresholdPts` percentage points. Names the two rates, the gap, the
 * reported revenue YoY (the model's latest read), and the top sensitivity driver (the swing factor).
 * Returns null when either input is null, or when the divergence is within threshold — never fabricates.
 */
export function pbeatDivergenceNote(
  beatProb: ScenarioOutput["beat_probability"],
  trailingRate: number | null,
  model: FinancialModel,
  sensitivity: ScenarioOutput["sensitivity"],
  cfg: PbeatConfig,
): string | null {
  const p = beatProb.revenue;
  if (p == null || trailingRate == null) return null;
  const modelPct = p * 100;
  const trailPct = trailingRate * 100;
  const gap = Math.abs(modelPct - trailPct);
  if (gap <= cfg.thresholdPts) return null;

  const reportedYoy = model.line_items.revenue?.yoy?.change_pct;
  const reportedStr = reportedYoy != null && Number.isFinite(reportedYoy)
    ? `latest reported revenue YoY ${(reportedYoy * 100).toFixed(1)}%`
    : "no reported YoY on file";
  const topDriver = sensitivity[0]?.driver ?? "an unranked driver";
  const richer = modelPct > trailPct ? "richer than" : "below";

  return `Momentum proxy (NOT a forecast): the model implies a ${modelPct.toFixed(0)}% chance of beating `
    + `consensus revenue next quarter — ${gap.toFixed(0)}pts ${richer} the ${trailPct.toFixed(0)}% of trailing `
    + `quarters that grew revenue YoY (${reportedStr}); the swing factor is ${topDriver}.`;
}
