/**
 * Monte Carlo next-period scenario (Phase-4 improvement #4). Pure TS — no LLM in the math. Samples
 * the MD&A-derived driver ranges (triangular) combined with the metric's own historical volatility,
 * to produce a DISTRIBUTION of next-period revenue / net income / EPS, a probability of beating the
 * Perplexity consensus, a sensitivity ranking, and measurable "what to watch next" items.
 *
 * Hybrid bounding (owner decision 2026-06-30): the LLM proposes each driver's bear/base/bull, but a
 * sampled impact is clamped to ±boundSigma × the metric's historical σ — history keeps the model honest.
 */
import type { Driver, WatchItem } from "../types";
import type { Stats } from "./model";

/** Deterministic PRNG (mulberry32) so scenarios are reproducible + tests are stable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleTriangular(rng: () => number, lo: number, mode: number, hi: number): number {
  if (hi <= lo) return mode;
  const u = rng();
  const c = (mode - lo) / (hi - lo);
  return u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
}

function sampleNormal(rng: () => number, mean: number, sd: number): number {
  if (sd <= 0) return mean;
  const u1 = Math.max(rng(), 1e-12), u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}
const band = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p10: percentile(s, 0.1), p50: percentile(s, 0.5), p90: percentile(s, 0.9) };
};

/** Analytic variance of a triangular(lo, mode, hi). */
function triVariance(lo: number, mode: number, hi: number): number {
  return (lo * lo + mode * mode + hi * hi - lo * mode - lo * hi - mode * hi) / 18;
}

const MARGIN_METRICS = new Set(["gross_margin", "operating_margin", "net_margin"]);

export interface ScenarioInputs {
  drivers: Driver[];
  revenue_prior_year: number;   // base to grow into the next period
  base_period: string | null;
  target_period: string | null;
  net_margin: number;           // latest net margin level (fraction)
  shares: number | null;        // net_income / eps_diluted, for EPS bands
  revenue_growth: Stats;        // historical YoY revenue-growth stats
  net_margin_stdev: number;     // historical net-margin-level σ
  consensus?: { revenue_estimate_usd?: number | null; eps_estimate?: number | null } | null;
  runs: number;
  boundSigma: number;
  sensitivityTopN: number;
  rng?: () => number;
}

export interface ScenarioOutput {
  target_period: string | null;
  base_period: string | null;
  runs: number;
  bands: {
    revenue: { p10: number; p50: number; p90: number };
    net_income: { p10: number; p50: number; p90: number };
    eps?: { p10: number; p50: number; p90: number };
    revenue_growth: { p10: number; p50: number; p90: number };
    net_margin: { p10: number; p50: number; p90: number };
  };
  beat_probability: { revenue: number | null; eps: number | null };
  sensitivity: Array<{ driver: string; metric: Driver["metric"]; contribution: number }>;
  watch: WatchItem[];
  watch_items: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${(x / 1e9).toFixed(2)}B`;
const eps$ = (x: number) => `$${x.toFixed(2)}`;

type AffectedBand = WatchItem["affected_band"];

/** Which OUTPUT band a driver's metric flows into. A margin driver moves net_margin, NEVER revenue. */
function affectedBandFor(metric: Driver["metric"]): AffectedBand {
  if (metric === "revenue") return "revenue";
  if (metric === "net_income") return "net_income";
  if (metric === "eps") return "eps";
  return "net_margin"; // gross_margin / operating_margin / net_margin
}

const BAND_LABEL: Record<AffectedBand, string> = {
  revenue: "revenue",
  net_margin: "net margin",
  net_income: "net income",
  eps: "EPS",
};

/** Per-band value formatting: usd $B for revenue/net_income, $x.xx for eps, % for margins. */
function fmtBand(bandKey: AffectedBand, value: number): string {
  if (bandKey === "eps") return eps$(value);
  if (bandKey === "net_margin") return pct(value);
  return usd(value); // revenue, net_income
}

/**
 * Pure, exported renderer of typed "what to watch" items. For each of the top-N sensitivity drivers it
 * derives the affected OUTPUT band from the driver's metric, reads that band's P10 (bear) / P90 (bull),
 * and formats per-band. If the driver's target band is missing (e.g. eps band when shares are unknown),
 * the item is SKIPPED — never fabricated. `text` carries the plain-language string.
 */
export function computeWatchItems(
  sensitivity: ScenarioOutput["sensitivity"],
  drivers: Driver[],
  bands: ScenarioOutput["bands"],
  topN: number,
): WatchItem[] {
  const out: WatchItem[] = [];
  for (const s of sensitivity.slice(0, topN)) {
    const d = drivers.find((x) => x.name === s.driver);
    if (!d) continue;
    const affected_band = affectedBandFor(d.metric);
    const targetBand = bands[affected_band];
    if (!targetBand) continue; // missing band (eps optional) → skip, never fabricate
    const bear_pts = Math.min(d.impact_pct.bear, d.impact_pct.bull);
    const bull_pts = Math.max(d.impact_pct.bear, d.impact_pct.bull);
    const bear_value = targetBand.p10; // invariant: bear → P10
    const bull_value = targetBand.p90; // invariant: bull → P90
    const metricLabel = d.metric.replace(/_/g, " ");
    const text =
      `${d.name} (${(s.contribution * 100).toFixed(0)}% of outcome variance): ${metricLabel} ` +
      `bear ${bear_pts > 0 ? "+" : ""}${bear_pts}pts / bull ${bull_pts > 0 ? "+" : ""}${bull_pts}pts ` +
      `moves ${BAND_LABEL[affected_band]} to ${fmtBand(affected_band, bear_value)} (P10) … ${fmtBand(affected_band, bull_value)} (P90).`;
    out.push({ driver: d.name, metric: d.metric, affected_band, bear_pts, bull_pts, bear_value, bull_value, contribution: s.contribution, text });
  }
  return out;
}

/** Clamp a sampled impact (in percentage points) to ±boundSigma×σ when history supports it. */
function bound(samplePts: number, sigmaPts: number, boundSigma: number, haveHistory: boolean): number {
  if (!haveHistory || sigmaPts <= 0) return samplePts; // not enough history → trust the LLM range
  const b = boundSigma * sigmaPts;
  return Math.max(-b, Math.min(b, samplePts));
}

export function simulateScenario(input: ScenarioInputs): ScenarioOutput {
  const rng = input.rng ?? mulberry32(1);
  const revDrivers = input.drivers.filter((d) => d.metric === "revenue");
  const marginDrivers = input.drivers.filter((d) => MARGIN_METRICS.has(d.metric));
  const revSigmaPts = input.revenue_growth.stdev * 100;
  const marginSigmaPts = input.net_margin_stdev * 100;
  const haveRevHist = input.revenue_growth.n >= 3;
  const haveMarginHist = input.net_margin_stdev > 0;

  const revenue: number[] = [], netIncome: number[] = [], eps: number[] = [], growth: number[] = [], margin: number[] = [];
  let beatRev = 0, beatEps = 0;

  for (let i = 0; i < input.runs; i++) {
    let g = input.revenue_growth.mean + sampleNormal(rng, 0, input.revenue_growth.stdev);
    for (const d of revDrivers) {
      const s = sampleTriangular(rng, Math.min(d.impact_pct.bear, d.impact_pct.bull), d.impact_pct.base, Math.max(d.impact_pct.bear, d.impact_pct.bull));
      g += bound(s, revSigmaPts, input.boundSigma, haveRevHist) / 100;
    }
    let m = input.net_margin + sampleNormal(rng, 0, input.net_margin_stdev);
    for (const d of marginDrivers) {
      const s = sampleTriangular(rng, Math.min(d.impact_pct.bear, d.impact_pct.bull), d.impact_pct.base, Math.max(d.impact_pct.bear, d.impact_pct.bull));
      m += bound(s, marginSigmaPts, input.boundSigma, haveMarginHist) / 100;
    }
    // Safety bounds against pathological driver stacking — a single quarter doesn't swing this far.
    g = Math.max(-0.6, Math.min(0.6, g));
    m = Math.max(0, Math.min(0.6, m));
    const rev = input.revenue_prior_year * (1 + g);
    const ni = rev * m;
    revenue.push(rev); growth.push(g); margin.push(m); netIncome.push(ni);
    if (input.shares) eps.push(ni / input.shares);
    if (input.consensus?.revenue_estimate_usd && rev >= input.consensus.revenue_estimate_usd) beatRev++;
    if (input.consensus?.eps_estimate && input.shares && ni / input.shares >= input.consensus.eps_estimate) beatEps++;
  }

  // Analytic sensitivity: each driver's contribution to output variance, in $ terms (comparable across metrics).
  const revMean = revenue.reduce((a, b) => a + b, 0) / Math.max(1, revenue.length);
  const contrib = input.drivers.map((d) => {
    const v = triVariance(d.impact_pct.bear, d.impact_pct.base, d.impact_pct.bull) / 1e4; // pts² → fraction²
    const dollarVar = d.metric === "revenue" ? v * input.revenue_prior_year ** 2 : v * revMean ** 2;
    return { driver: d.name, metric: d.metric, raw: dollarVar };
  });
  const total = contrib.reduce((a, c) => a + c.raw, 0) || 1;
  const sensitivity = contrib
    .map((c) => ({ driver: c.driver, metric: c.metric, contribution: c.raw / total }))
    .sort((a, b) => b.contribution - a.contribution);

  const bands: ScenarioOutput["bands"] = {
    revenue: band(revenue), net_income: band(netIncome), revenue_growth: band(growth), net_margin: band(margin),
    ...(eps.length ? { eps: band(eps) } : {}),
  };
  const watch = computeWatchItems(sensitivity, input.drivers, bands, input.sensitivityTopN);
  const watch_items = watch.map((w) => w.text); // keep string[] so all downstream string consumers stay untouched

  return {
    target_period: input.target_period, base_period: input.base_period, runs: input.runs,
    bands,
    beat_probability: {
      revenue: input.consensus?.revenue_estimate_usd ? beatRev / input.runs : null,
      eps: input.consensus?.eps_estimate && input.shares ? beatEps / input.runs : null,
    },
    sensitivity, watch, watch_items,
  };
}

export { pct as fmtPct, usd as fmtUsd };
