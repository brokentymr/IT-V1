/**
 * Multi-year trend metrics (grounding v2 — W3). Grounds the historical-baseline claims the desk
 * otherwise asserts from memory ("peak margin", "highest ever", "cyclical") by computing them from the
 * filing history (the XBRL company-facts series). Pure — the caller supplies the series via the existing
 * history helpers (metricYoYGrowths / netMarginLevels).
 */

export interface SeriesStat {
  mean: number | null;
  stdev: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

export function summarizeSeries(values: number[]): SeriesStat {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return { mean: null, stdev: null, min: null, max: null, n: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  return { mean, stdev: Math.sqrt(variance), min: Math.min(...v), max: Math.max(...v), n: v.length };
}

export interface Trends {
  revenue_growth: SeriesStat; // YoY growth series → cyclicality
  net_margin: SeriesStat; // level series → peak/trough/normal
  current_net_margin: number | null;
  margin_vs_peak: "above_peak" | "at_peak" | "below_peak" | null; // is the current print a new peak?
  read: string;
}

const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);

/** Compute grounded trend context from the historical series + the current print. */
export function computeTrends(revenueGrowths: number[], marginLevels: number[], currentMargin: number | null): Trends {
  const rg = summarizeSeries(revenueGrowths);
  const nm = summarizeSeries(marginLevels);

  let margin_vs_peak: Trends["margin_vs_peak"] = null;
  if (currentMargin != null && nm.max != null) {
    margin_vs_peak = currentMargin > nm.max * 1.01 ? "above_peak" : currentMargin >= nm.max * 0.99 ? "at_peak" : "below_peak";
  }

  const parts: string[] = [];
  if (rg.n) parts.push(`revenue growth over ${rg.n} periods averaged ${pct(rg.mean)} with ${pct(rg.stdev)} volatility (cyclicality)`);
  if (nm.n) parts.push(`net margin ranged ${pct(nm.min)}–${pct(nm.max)} (avg ${pct(nm.mean)})`);
  if (currentMargin != null && margin_vs_peak) {
    parts.push(`current ${pct(currentMargin)} is ${margin_vs_peak === "above_peak" ? "a NEW peak vs the historical range" : margin_vs_peak === "at_peak" ? "at the historical peak" : "within the historical range"}`);
  }
  const read = parts.length ? `Historical context (from the filing series — ground truth): ${parts.join("; ")}.` : "";

  return { revenue_growth: rg, net_margin: nm, current_net_margin: currentMargin, margin_vs_peak, read };
}
