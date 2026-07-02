import { describe, it, expect } from "vitest";
import { simulateScenario, computeWatchItems, mulberry32, type ScenarioInputs, type ScenarioOutput } from "./montecarlo";
import { WatchItem } from "../types";
import type { Driver } from "../types";

// Golden tests for control P6: the typed Monte-Carlo WatchItem renderer. Deterministic seed → stable
// bands → stable watch items. Asserts the affected-band derivation, per-band formatting, and the
// bear→P10 / bull→P90 invariant.

const baseInputs = (drivers: Driver[], over: Partial<ScenarioInputs> = {}): ScenarioInputs => ({
  drivers,
  revenue_prior_year: 100_000_000_000,
  base_period: "2025-06-30",
  target_period: "2026-06-30",
  net_margin: 0.25,
  shares: 15_000_000_000,
  revenue_growth: { mean: 0.05, stdev: 0.02, n: 8 },
  net_margin_stdev: 0.01,
  consensus: { revenue_estimate_usd: 105_000_000_000, eps_estimate: 1.8 },
  runs: 5000,
  boundSigma: 2,
  sensitivityTopN: 3,
  rng: mulberry32(42),
  ...over,
});

const bullRev: Driver = { name: "Bull services", metric: "revenue", direction: "tailwind", framing: "", quote: null, impact_pct: { bear: 0, base: 3, bull: 6 } };
const bearRev: Driver = { name: "Bear FX", metric: "revenue", direction: "headwind", framing: "", quote: null, impact_pct: { bear: -6, base: -2, bull: 0 } };
const marginDriver: Driver = { name: "Component costs", metric: "gross_margin", direction: "headwind", framing: "", quote: null, impact_pct: { bear: -4, base: -1, bull: 0 } };
const epsDriver: Driver = { name: "Buyback", metric: "eps", direction: "tailwind", framing: "", quote: null, impact_pct: { bear: 0, base: 1, bull: 2 } };

describe("Monte Carlo WatchItem renderer (P6 golden)", () => {
  it("emits typed watch items that parse against the WatchItem schema", () => {
    const s = simulateScenario(baseInputs([bullRev, bearRev, marginDriver]));
    expect(s.watch.length).toBe(3);
    for (const w of s.watch) expect(() => WatchItem.parse(w)).not.toThrow();
    // watch_items stays a string[] mirror of watch.text so downstream string consumers are untouched
    expect(s.watch_items).toEqual(s.watch.map((w) => w.text));
    expect(s.watch_items.every((t) => typeof t === "string")).toBe(true);
  });

  it("a revenue driver maps to the revenue band with bear→P10 / bull→P90 (usd $B)", () => {
    const s = simulateScenario(baseInputs([bullRev]));
    const w = s.watch.find((x) => x.driver === "Bull services")!;
    expect(w.affected_band).toBe("revenue");
    expect(w.bear_pts).toBe(0); // min(0,6)
    expect(w.bull_pts).toBe(6); // max(0,6)
    expect(w.bear_value).toBe(s.bands.revenue.p10);
    expect(w.bull_value).toBe(s.bands.revenue.p90);
    expect(w.text).toContain("$");
    expect(w.text).toContain("B");
    expect(w.text).toContain("revenue");
  });

  it("a bear revenue driver normalizes bear_pts=min / bull_pts=max regardless of sign order", () => {
    const s = simulateScenario(baseInputs([bearRev]));
    const w = s.watch.find((x) => x.driver === "Bear FX")!;
    expect(w.affected_band).toBe("revenue");
    expect(w.bear_pts).toBe(-6);
    expect(w.bull_pts).toBe(0);
    expect(w.bear_value).toBe(s.bands.revenue.p10);
    expect(w.bull_value).toBe(s.bands.revenue.p90);
  });

  it("a margin driver maps to net_margin (NEVER revenue) with % formatting and no '$'/'revenue' in text", () => {
    const s = simulateScenario(baseInputs([marginDriver]));
    const w = s.watch.find((x) => x.driver === "Component costs")!;
    expect(w.affected_band).toBe("net_margin");
    expect(w.bear_value).toBe(s.bands.net_margin!.p10);
    expect(w.bull_value).toBe(s.bands.net_margin!.p90);
    expect(w.text).not.toContain("$");
    expect(w.text).not.toContain("revenue");
    expect(w.text).toContain("%");
  });

  it("an eps driver formats as $x.xx when the eps band exists", () => {
    const s = simulateScenario(baseInputs([epsDriver]));
    const w = s.watch.find((x) => x.driver === "Buyback")!;
    expect(w.affected_band).toBe("eps");
    expect(w.bear_value).toBe(s.bands.eps!.p10);
    expect(w.bull_value).toBe(s.bands.eps!.p90);
    expect(w.text).toMatch(/\$\d+\.\d{2}/); // $x.xx guard
  });

  it("skips a watch item whose target band is missing (eps band absent, never fabricates)", () => {
    // shares=null → no eps band produced; an eps driver must be skipped rather than crash/fabricate.
    const s = simulateScenario(baseInputs([epsDriver, bullRev], { shares: null, consensus: null }));
    expect(s.bands.eps).toBeUndefined();
    expect(s.watch.find((x) => x.driver === "Buyback")).toBeUndefined();
    // the revenue driver still renders
    expect(s.watch.find((x) => x.driver === "Bull services")).toBeDefined();
  });

  it("computeWatchItems is pure and skips drivers with no matching sensitivity entry", () => {
    const bands: ScenarioOutput["bands"] = {
      revenue: { p10: 90e9, p50: 100e9, p90: 110e9 },
      net_income: { p10: 20e9, p50: 25e9, p90: 30e9 },
      revenue_growth: { p10: -0.05, p50: 0.05, p90: 0.12 },
      net_margin: { p10: 0.22, p50: 0.25, p90: 0.28 },
    };
    const sensitivity: ScenarioOutput["sensitivity"] = [{ driver: "Ghost", metric: "revenue", contribution: 1 }];
    // driver list does not contain "Ghost" → nothing emitted
    expect(computeWatchItems(sensitivity, [bullRev], bands, 3)).toEqual([]);
    // present driver → one item
    const items = computeWatchItems([{ driver: "Bull services", metric: "revenue", contribution: 1 }], [bullRev], bands, 3);
    expect(items.length).toBe(1);
    expect(items[0].bear_value).toBe(90e9);
    expect(items[0].bull_value).toBe(110e9);
  });
});
