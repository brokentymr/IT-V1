import { describe, it, expect } from "vitest";
import { buildPriceContext } from "../lib/engines/price_context";
import { PRICE_CONTEXT_CONFIG } from "../lib/config/prices";
import type { DailyBar } from "../lib/sources/prices";

// Build a bar series from closes, oldest→newest, one bar per day from 2026-06-01.
const bars = (closes: number[]): DailyBar[] =>
  closes.map((c, i) => ({
    date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10),
    open: c, high: c, low: c, close: c, volume: 1000,
  }));

describe("buildPriceContext", () => {
  it("degrades to an unusable context with no bars (never fabricates)", () => {
    const ctx = buildPriceContext({ bars: null, analystTarget: 85 });
    expect(ctx.ok).toBe(false);
    expect(ctx.current_price).toBeNull();
    expect(ctx.market_repriced).toBe(false);
    expect(ctx.stale_frame).toBe(false);
    expect(ctx.analyst_target).toBe(85); // still echoes what it was given
  });

  it("anchors to the verified last close and its date", () => {
    const ctx = buildPriceContext({ bars: bars([80, 75, 70, 66, 65]), analystTarget: null });
    expect(ctx.ok).toBe(true);
    expect(ctx.current_price).toBe(65);
    expect(ctx.as_of).toBe("2026-06-05");
    expect(ctx.low_2m).toBe(65);
    expect(ctx.high_2m).toBe(80);
  });

  // The CAVA-shaped case: ~$65 sitting near its 2-month low, a $84.70 target left un-cut above it.
  it("flags a stale frame when the target sits well above a price near its recent low", () => {
    const ctx = buildPriceContext({ bars: bars([85, 80, 74, 68, 65.2, 65]), analystTarget: 84.7 });
    expect(ctx.target_gap_pct).toBeGreaterThanOrEqual(PRICE_CONTEXT_CONFIG.repricedGapPct); // ~30% above
    expect(ctx.off_low_pct).toBeLessThanOrEqual(PRICE_CONTEXT_CONFIG.nearLowPct);            // basically at the low
    expect(ctx.market_repriced).toBe(true);
    expect(ctx.stale_frame).toBe(true);
    expect(ctx.note).toMatch(/pending downgrade/i);
  });

  it("does NOT flag when price and target are broadly aligned", () => {
    // Price $82 near its high, target $85 only ~4% above → ordinary discount, no repricing signal.
    const ctx = buildPriceContext({ bars: bars([78, 79, 80, 81, 82]), analystTarget: 85 });
    expect(ctx.market_repriced).toBe(false);
    expect(ctx.stale_frame).toBe(false);
    expect(ctx.note).toMatch(/broadly aligned/i);
  });

  it("flags on a sharp drawdown even without a target (tape-only signal)", () => {
    // Down ~24% over the window, no target supplied.
    const ctx = buildPriceContext({ bars: bars([100, 95, 88, 80, 76]), analystTarget: null });
    expect(ctx.ret_30d).toBeLessThanOrEqual(PRICE_CONTEXT_CONFIG.ret30dRepricePct);
    expect(ctx.market_repriced).toBe(true);
    expect(ctx.target_gap_pct).toBeNull();
  });

  it("a large gap to target does NOT flag when price is not near its low (mid-window)", () => {
    // Target 30% above, but price is well off the low (recovered) → not a repriced-near-low signal,
    // and the window is flat so no drawdown signal either.
    const ctx = buildPriceContext({ bars: bars([50, 55, 60, 63, 65]), analystTarget: 84.5 });
    expect(ctx.target_gap_pct).toBeGreaterThanOrEqual(PRICE_CONTEXT_CONFIG.repricedGapPct);
    expect(ctx.off_low_pct).toBeGreaterThan(PRICE_CONTEXT_CONFIG.nearLowPct); // +30% off the low
    expect(ctx.market_repriced).toBe(false);
  });
});
