/**
 * Deterministic financial model (Phase 4). The numbers are computed in TypeScript straight from
 * SEC XBRL company facts — no LLM in the math path (owner decision 2026-06-30: cheaper, exactly
 * reproducible, Haiku-safe). The LLM only narrates the thesis on top of these figures.
 *
 * Extraction is grounded to a filing: we prefer the values whose XBRL `accn` matches the filing
 * that triggered the pass, so every line item carries the accession that reported it (provenance).
 */
import type { CompanyFacts, XbrlUnitValue } from "../sources/sec";
import { FUNDAMENTALS_CONFIG, type FundamentalsConfig, type MetricSpec } from "../config/fundamentals";

export interface LineItem {
  key: string;
  label: string;
  value: number;
  unit: string;
  period_end: string;
  period_start: string | null;
  fy: number | null;
  fp: string | null;       // FY | Q1 | Q2 | Q3
  form: string | null;
  accession: string | null; // provenance: the filing that reported this value
  yoy: { prior_value: number; prior_end: string; change_pct: number } | null;
}

export interface FinancialModel {
  period_end: string | null;
  fiscal_period: string | null; // e.g. "FY2024" or "Q3 2024"
  line_items: Record<string, LineItem>;
  ratios: Record<string, number>; // gross_margin, operating_margin, net_margin (fractions 0..1)
}

const normAccn = (a: string | undefined | null): string => (a ?? "").replace(/-/g, "");

/** All unit values for a metric across its fallback tags, tagged with the resolving concept. */
function valuesFor(facts: CompanyFacts, spec: MetricSpec): Array<XbrlUnitValue & { concept: string }> {
  for (const tag of spec.tags) {
    const concept = facts.facts["us-gaap"]?.[tag];
    const arr = concept?.units?.[spec.unit];
    if (arr?.length) return arr.map((v) => ({ ...v, concept: tag }));
  }
  return [];
}

/** Pick the value reported by `accession` if present; else the latest by period end. */
function pick(
  values: Array<XbrlUnitValue & { concept: string }>,
  accession: string | null,
): (XbrlUnitValue & { concept: string }) | null {
  if (!values.length) return null;
  if (accession) {
    const want = normAccn(accession);
    const matched = values.filter((v) => normAccn(v.accn) === want);
    if (matched.length) return matched.sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  }
  return [...values].sort((a, b) => (a.end < b.end ? 1 : -1))[0];
}

/** Same fiscal period (fp), one year earlier — for year-over-year. */
function priorYear(
  values: Array<XbrlUnitValue & { concept: string }>,
  current: XbrlUnitValue,
): XbrlUnitValue | null {
  const curYear = Number(current.end.slice(0, 4));
  const candidates = values
    .filter((v) => v.fp === current.fp && Number(v.end.slice(0, 4)) === curYear - 1)
    .sort((a, b) => (a.end < b.end ? 1 : -1));
  return candidates[0] ?? null;
}

function fiscalPeriodLabel(fp: string | null, fy: number | null, end: string | null): string | null {
  if (!fp) return null;
  const year = fy ?? (end ? Number(end.slice(0, 4)) : null);
  return fp === "FY" ? `FY${year ?? "?"}` : `${fp} ${year ?? "?"}`;
}

/**
 * Extract a filing's line items from XBRL facts. Grounded to `accession` when supplied.
 * Missing concepts are simply absent (degrade, don't throw) — the caller records them as gaps.
 */
export function extractStatements(
  facts: CompanyFacts,
  opts: { accession?: string | null; config?: FundamentalsConfig } = {},
): { line_items: Record<string, LineItem>; missing: string[] } {
  const config = opts.config ?? FUNDAMENTALS_CONFIG;
  const accession = opts.accession ?? null;
  const line_items: Record<string, LineItem> = {};
  const missing: string[] = [];

  for (const spec of config.metrics) {
    const values = valuesFor(facts, spec);
    const chosen = pick(values, accession);
    if (!chosen) { missing.push(spec.key); continue; }
    const prior = spec.kind === "flow" ? priorYear(values, chosen) : null;
    line_items[spec.key] = {
      key: spec.key,
      label: spec.label,
      value: chosen.val,
      unit: spec.unit,
      period_end: chosen.end,
      period_start: chosen.start ?? null,
      fy: chosen.fy ?? null,
      fp: chosen.fp ?? null,
      form: chosen.form ?? null,
      accession: chosen.accn ?? null,
      yoy: prior && prior.val !== 0
        ? { prior_value: prior.val, prior_end: prior.end, change_pct: (chosen.val - prior.val) / Math.abs(prior.val) }
        : null,
    };
  }
  return { line_items, missing };
}

const ratio = (num: number | undefined, den: number | undefined): number | null =>
  num != null && den ? num / den : null;

/** Build the model: line items + derived margin ratios (fractions). */
export function buildModel(line_items: Record<string, LineItem>): FinancialModel {
  const v = (k: string): number | undefined => line_items[k]?.value;
  const ratios: Record<string, number> = {};
  const gm = ratio(v("gross_profit") ?? (v("revenue") != null && v("cost_of_revenue") != null
    ? (v("revenue") as number) - (v("cost_of_revenue") as number) : undefined), v("revenue"));
  const om = ratio(v("operating_income"), v("revenue"));
  const nm = ratio(v("net_income"), v("revenue"));
  if (gm != null) ratios.gross_margin = gm;
  if (om != null) ratios.operating_margin = om;
  if (nm != null) ratios.net_margin = nm;

  // Anchor the period on revenue (or net income) — the headline flow item.
  const anchor = line_items.revenue ?? line_items.net_income ?? Object.values(line_items)[0];
  return {
    period_end: anchor?.period_end ?? null,
    fiscal_period: anchor ? fiscalPeriodLabel(anchor.fp, anchor.fy, anchor.period_end) : null,
    line_items,
    ratios,
  };
}

export interface MetricDiff {
  key: string;
  label: string;
  prior: number | null;
  current: number;
  change: number | null;
  change_pct: number | null;
  direction: "up" | "down" | "flat" | "new";
}

export interface SnapshotDiff {
  prior_period: string | null;
  current_period: string | null;
  metrics: MetricDiff[];
  ratios: Record<string, { prior: number | null; current: number; change: number | null }>;
}

// ---------------------------------------------------------------------------
// Historical series + volatility (inputs to the Monte Carlo, Phase-4 improvement #4).
// ---------------------------------------------------------------------------
export interface Stats { mean: number; stdev: number; n: number }

/**
 * True for a ~3-month (fiscal-quarter) flow value. XBRL tags 3/6/9-month and annual figures under
 * the same concept+unit; mixing durations produces nonsense "growth" (e.g. 9-month ÷ 3-month), so
 * the volatility/base series below keep ONLY quarterly periods. (Stock items have no start → excluded.)
 */
function isQuarter(v: XbrlUnitValue): boolean {
  if (!v.start) return false;
  const days = (Date.parse(`${v.end}T00:00:00Z`) - Date.parse(`${v.start}T00:00:00Z`)) / 86_400_000;
  return days >= 80 && days <= 100;
}

export function stats(xs: number[]): Stats {
  const n = xs.length;
  if (!n) return { mean: 0, stdev: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, stdev: Math.sqrt(variance), n };
}

/** Year-over-year growth observations for a metric (same fiscal period, one year apart). */
export function metricYoYGrowths(facts: CompanyFacts, metricKey: string, config: FundamentalsConfig = FUNDAMENTALS_CONFIG): number[] {
  const spec = config.metrics.find((m) => m.key === metricKey);
  if (!spec) return [];
  const values = valuesFor(facts, spec).filter(isQuarter); // quarterly-only, consistent duration
  const out: number[] = [];
  for (const v of values) {
    const prior = priorYear(values, v);
    if (prior && prior.val !== 0) out.push((v.val - prior.val) / Math.abs(prior.val));
  }
  return out;
}

/** Net-margin level observations (net income / revenue) aligned by period. */
export function netMarginLevels(facts: CompanyFacts, config: FundamentalsConfig = FUNDAMENTALS_CONFIG): number[] {
  const rspec = config.metrics.find((m) => m.key === "revenue");
  const nspec = config.metrics.find((m) => m.key === "net_income");
  if (!rspec || !nspec) return [];
  const rev = new Map(valuesFor(facts, rspec).filter(isQuarter).map((v) => [`${v.end}:${v.fp ?? ""}`, v.val]));
  const out: number[] = [];
  for (const ni of valuesFor(facts, nspec).filter(isQuarter)) {
    const r = rev.get(`${ni.end}:${ni.fp ?? ""}`);
    if (r && r !== 0) out.push(ni.val / r);
  }
  return out;
}

/**
 * The prior-year comparable value to grow into the NEXT period: the metric reading whose period end
 * is ~9 months before the latest (so it laps the upcoming quarter a year on). Falls back to the
 * latest value (a sequential proxy) when no good comparable exists.
 */
export function priorYearBaseForNext(
  facts: CompanyFacts, metricKey: string, latestEnd: string, config: FundamentalsConfig = FUNDAMENTALS_CONFIG,
): { value: number; period_end: string; proxy: boolean } | null {
  const spec = config.metrics.find((m) => m.key === metricKey);
  if (!spec) return null;
  const values = valuesFor(facts, spec).filter(isQuarter); // consistent ~3-month periods only
  if (!values.length) return null;
  const targetMs = Date.parse(`${latestEnd}T00:00:00Z`) - 273 * 86_400_000;
  let best = values[0];
  let bestGap = Infinity;
  for (const v of values) {
    const gap = Math.abs(Date.parse(`${v.end}T00:00:00Z`) - targetMs);
    if (gap < bestGap) { bestGap = gap; best = v; }
  }
  const proxy = bestGap > 60 * 86_400_000; // no comparable within ~2 months → proxy
  const latest = [...values].sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  return proxy ? { value: latest.val, period_end: latest.end, proxy: true } : { value: best.val, period_end: best.end, proxy: false };
}

/** Diff the current model against the prior snapshot's model — the first-class "what changed". */
export function diffModels(prev: FinancialModel | null, curr: FinancialModel): SnapshotDiff {
  const metrics: MetricDiff[] = [];
  for (const [key, li] of Object.entries(curr.line_items)) {
    const prior = prev?.line_items[key]?.value ?? null;
    const change = prior != null ? li.value - prior : null;
    const change_pct = prior != null && prior !== 0 ? (li.value - prior) / Math.abs(prior) : null;
    const direction: MetricDiff["direction"] =
      prior == null ? "new" : change === 0 ? "flat" : (change as number) > 0 ? "up" : "down";
    metrics.push({ key, label: li.label, prior, current: li.value, change, change_pct, direction });
  }
  const ratios: SnapshotDiff["ratios"] = {};
  for (const [k, cur] of Object.entries(curr.ratios)) {
    const prior = prev?.ratios[k] ?? null;
    ratios[k] = { prior, current: cur, change: prior != null ? cur - prior : null };
  }
  return { prior_period: prev?.period_end ?? null, current_period: curr.period_end, metrics, ratios };
}
