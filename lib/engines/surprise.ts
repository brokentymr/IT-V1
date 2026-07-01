/**
 * Surprise / anomaly investigator (pipeline upgrade — see docs/UPGRADE-pipeline-rearchitecture.md §3).
 *
 * A large deviation from a company's own history or from consensus is a SIGNAL TO INVESTIGATE, not
 * evidence of a data error. This module detects those deviations and produces a briefing the analyst
 * desk must heed: treat reported figures as REAL, explain WHY the surprise happened, and judge its
 * DURABILITY — never dismiss a surprising-but-reported number as "implausible."
 *
 * This exists because the desk once called a true, reported 84.9% gross margin "physically impossible"
 * and spent an entire report litigating whether the real print was a bug. Rejecting true data because
 * it violates a prior is the single most dangerous failure an analyst can make; this closes it.
 */

export type SurpriseKind = "yoy_growth" | "margin_pp" | "vs_consensus";

/** One reported-vs-comparison pair the detector scores. `current` and `baseline` are raw values
 *  (dollars, or a ratio in 0..1 for margins). */
export interface Observation {
  key: string;
  label: string;
  current: number;
  baseline: number;
  baselineSource: string;
  kind: SurpriseKind;
  unit?: string; // "USD" | "USD/shares" | "ratio" | ...
}

export type Magnitude = "normal" | "notable" | "large" | "extreme";

export interface Surprise extends Observation {
  deltaPct: number | null; // relative delta (levels/growth/consensus)
  deltaPp: number | null; // percentage-point delta (ratios/margins)
  magnitude: Magnitude;
  direction: "up" | "down";
}

export interface SurpriseConfig {
  /** Relative-delta thresholds (as fractions) for level/growth/consensus comparisons. */
  notablePct: number;
  largePct: number;
  extremePct: number;
  /** Percentage-point thresholds for ratio/margin comparisons. */
  notablePp: number;
  largePp: number;
  extremePp: number;
}

export const SURPRISE_CONFIG: SurpriseConfig = {
  notablePct: 0.15,
  largePct: 0.4,
  extremePct: 1.0,
  notablePp: 3,
  largePp: 10,
  extremePp: 20,
};

const classifyPct = (absPct: number, c: SurpriseConfig): Magnitude =>
  absPct >= c.extremePct ? "extreme" : absPct >= c.largePct ? "large" : absPct >= c.notablePct ? "notable" : "normal";

const classifyPp = (absPp: number, c: SurpriseConfig): Magnitude =>
  absPp >= c.extremePp ? "extreme" : absPp >= c.largePp ? "large" : absPp >= c.notablePp ? "notable" : "normal";

/**
 * Score each observation and return the ones that rise to at least `notable`, most-severe first.
 * Ratio comparisons (margins) are scored in percentage points; everything else relatively.
 */
export function detectSurprises(observations: Observation[], config: SurpriseConfig = SURPRISE_CONFIG): Surprise[] {
  const rank: Record<Magnitude, number> = { normal: 0, notable: 1, large: 2, extreme: 3 };
  const out: Surprise[] = [];

  for (const o of observations) {
    if (!Number.isFinite(o.current) || !Number.isFinite(o.baseline)) continue;

    let deltaPct: number | null = null;
    let deltaPp: number | null = null;
    let magnitude: Magnitude;

    if (o.kind === "margin_pp") {
      deltaPp = (o.current - o.baseline) * 100;
      magnitude = classifyPp(Math.abs(deltaPp), config);
    } else {
      // Relative delta vs the baseline's magnitude. A zero baseline with a nonzero current is, by
      // definition, an extreme surprise (something appeared from nothing).
      if (o.baseline === 0) {
        deltaPct = o.current === 0 ? 0 : Infinity;
      } else {
        deltaPct = (o.current - o.baseline) / Math.abs(o.baseline);
      }
      magnitude = classifyPct(Math.abs(deltaPct), config);
    }

    if (magnitude === "normal") continue;
    const signed = o.kind === "margin_pp" ? (deltaPp as number) : (deltaPct as number);
    out.push({ ...o, deltaPct, deltaPp, magnitude, direction: signed >= 0 ? "up" : "down" });
  }

  return out.sort((a, b) => rank[b.magnitude] - rank[a.magnitude]);
}

const pct = (n: number) => (n === Infinity ? "n/a (from ~0)" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);
const money = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `${n.toFixed(2)}`);

function describe(s: Surprise): string {
  const tag = s.magnitude.toUpperCase();
  if (s.kind === "margin_pp") {
    return `${s.label}: ${(s.current * 100).toFixed(1)}% vs ${(s.baseline * 100).toFixed(1)}% ${s.baselineSource} (${(s.deltaPp as number) >= 0 ? "+" : ""}${(s.deltaPp as number).toFixed(1)}pts) — ${tag}.`;
  }
  if (s.kind === "vs_consensus") {
    const val = s.unit === "USD" ? money(s.current) : s.current.toFixed(2);
    const base = s.unit === "USD" ? money(s.baseline) : s.baseline.toFixed(2);
    return `${s.label}: reported ${val} vs consensus ${base} (${pct(s.deltaPct as number)}) — ${tag}.`;
  }
  // yoy_growth
  const val = s.unit === "USD/shares" ? s.current.toFixed(2) : money(s.current);
  const base = s.unit === "USD/shares" ? s.baseline.toFixed(2) : money(s.baseline);
  return `${s.label}: ${pct(s.deltaPct as number)} (reported ${val} vs ${s.baselineSource} ${base}) — ${tag}.`;
}

/**
 * The instruction block prepended to the desk's evidence. Only `large`/`extreme` surprises are
 * surfaced (notable ones are noise). Returns "" when nothing material moved, so the evidence is
 * unchanged on quiet quarters.
 */
export function surpriseBriefing(surprises: Surprise[]): string {
  const material = surprises.filter((s) => s.magnitude === "large" || s.magnitude === "extreme");
  if (!material.length) return "";
  return [
    "=== MATERIAL SURPRISES — INVESTIGATE, DO NOT DISMISS ===",
    "The figures below deviate sharply from history/consensus. They are REPORTED company data: treat",
    "them as REAL unless a primary source explicitly contradicts them. Your job is to explain WHY each",
    "surprise happened (mix shift, pricing, one-offs, demand, supply) and judge whether it is DURABLE or",
    "peak-cyclical — NOT to label a surprising number an error. Flagging true, reported data as",
    '"implausible" is an analytical failure. If a figure looks impossible, investigate the cause; do not',
    "dismiss the print.",
    ...material.map((s) => `- ${describe(s)}`),
    "=== END SURPRISES ===",
  ].join("\n");
}
