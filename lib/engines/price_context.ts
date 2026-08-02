/**
 * Price context + staleness guard (desk pipeline). Pure, deterministic (no RNG, no LLM, no network):
 * turn a window of daily bars and the sell-side price target into a VERIFIED current-price anchor plus
 * the "has the market already repriced?" signal the positioning desk needs.
 *
 * Why this exists: the desk historically reasoned off a hand-typed "current price" in the prompt and
 * consumed the analyst target with no recency check. When targets are stale (set months ago at a higher
 * price) and the market has since made new lows, the report's central framing — "big gap to the target
 * = buy the dislocation" — inverts: it may instead mean the street simply hasn't cut yet. This module
 * makes the current price a first-class, timestamped, provenance-able fact and derives whether the frame
 * the report is built on is likely stale.
 *
 * Degrades gracefully: no bars → a null-filled context flagged unusable (the caller degrades, never
 * fabricates). A missing analyst target drops the gap-based signal but keeps the drawdown-based one.
 */
import type { DailyBar } from "../sources/prices";
import { PRICE_CONTEXT_CONFIG, type PriceContextConfig } from "../config/prices";

export interface PriceContext {
  ok: boolean;                       // false → no usable bars; the rest is null and the caller degrades
  current_price: number | null;      // verified last close
  as_of: string | null;              // date of that close (YYYY-MM-DD)
  low_2m: number | null;             // lowest close in the window
  high_2m: number | null;            // highest close in the window
  ret_30d: number | null;            // fraction over the window (e.g. -0.22 = down 22%)
  drawdown_from_high: number | null; // (current - high)/high, ≤ 0
  off_low_pct: number | null;        // (current - low)/low, ≥ 0 — how far above the recent low
  analyst_target: number | null;     // from market_context (advisory), for the gap
  target_as_of: string | null;       // best-effort recency stamp on the target, if the source gave one
  target_gap_pct: number | null;     // (target - current)/current — positive = target sits above spot
  market_repriced: boolean;          // the market has moved ahead of the (possibly unrevised) target
  stale_frame: boolean;              // guard: the analytical frame is likely stale → route to review
  note: string;                      // plain-language one-liner for the prompt + report
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

/**
 * Build the verified price context. `bars` is oldest→newest (as PriceAdapter returns); the window is
 * whatever the caller pulled (default ~2 months), so low/high/return are "recent" by that window.
 */
export function buildPriceContext(
  input: { bars: DailyBar[] | null; analystTarget?: number | null; targetAsOf?: string | null },
  cfg: PriceContextConfig = PRICE_CONTEXT_CONFIG,
): PriceContext {
  const bars = input.bars ?? [];
  const target = input.analystTarget ?? null;
  const empty: PriceContext = {
    ok: false, current_price: null, as_of: null, low_2m: null, high_2m: null, ret_30d: null,
    drawdown_from_high: null, off_low_pct: null, analyst_target: target, target_as_of: input.targetAsOf ?? null,
    target_gap_pct: null, market_repriced: false, stale_frame: false,
    note: "No verified price available — analysis is not anchored to a current quote.",
  };
  if (!bars.length) return empty;

  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const current = last.close;
  const first = bars[0].close;
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const ret30d = first ? round2((current - first) / first) : null;
  const drawdown = high ? round2((current - high) / high) : null;
  const offLow = low ? round2((current - low) / low) : null;
  const gap = target != null && current ? round2((target - current) / current) : null;

  // "Market repriced" — two independent readings, either suffices:
  //  (a) the street target sits materially ABOVE a price that is itself sitting near its recent low
  //      (the target hasn't been cut to meet the tape), or
  //  (b) the tape itself has dropped sharply over the window regardless of any target.
  const gapSignal = gap != null && offLow != null && gap >= cfg.repricedGapPct && offLow <= cfg.nearLowPct;
  const drawSignal = ret30d != null && ret30d <= cfg.ret30dRepricePct;
  const repriced = gapSignal || drawSignal;

  const note = buildNote({ current, asOf: last.date, gap, ret30d, offLow, gapSignal, drawSignal, target });

  return {
    ok: true,
    current_price: current,
    as_of: last.date,
    low_2m: low,
    high_2m: high,
    ret_30d: ret30d,
    drawdown_from_high: drawdown,
    off_low_pct: offLow,
    analyst_target: target,
    target_as_of: input.targetAsOf ?? null,
    target_gap_pct: gap,
    market_repriced: repriced,
    stale_frame: repriced, // the guard is the repricing signal; the caller uses it to hold auto-publish
    note,
  };
}

function buildNote(a: {
  current: number; asOf: string; gap: number | null; ret30d: number | null; offLow: number | null;
  gapSignal: boolean; drawSignal: boolean; target: number | null;
}): string {
  const parts: string[] = [`Verified spot $${a.current} (as of ${a.asOf})`];
  if (a.ret30d != null) parts.push(`${a.ret30d >= 0 ? "+" : ""}${pct(a.ret30d)} over the window`);
  if (a.offLow != null) parts.push(`${pct(a.offLow)} off the recent low`);
  if (a.gap != null && a.target != null) parts.push(`sell-side target $${a.target} sits ${pct(a.gap)} above spot`);
  let verdict: string;
  if (a.gapSignal) {
    verdict = "The market has repriced BELOW an unrevised sell-side target — treat the gap-to-target as a pending downgrade risk, not a proven dislocation to buy. Re-underwrite before leaning on the target.";
  } else if (a.drawSignal) {
    verdict = "The tape has repriced sharply over the window — confirm the analytical frame (targets, filing) reflects the current price before acting.";
  } else {
    verdict = "Price and the sell-side frame are broadly aligned; no stale-frame flag.";
  }
  return `${parts.join(", ")}. ${verdict}`;
}
