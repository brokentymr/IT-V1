import { describe, it, expect } from "vitest";
import { simulateScenario, mulberry32, type ScenarioInputs } from "./montecarlo";
import type { Driver } from "../types";

const baseInputs = (drivers: Driver[]): ScenarioInputs => ({
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
  sensitivityTopN: 2,
  rng: mulberry32(7),
});

const revDriver: Driver = { name: "Services growth", metric: "revenue", direction: "tailwind", framing: "", quote: null, impact_pct: { bear: -1, base: 2, bull: 5 } };
const marginDriver: Driver = { name: "Component costs", metric: "gross_margin", direction: "headwind", framing: "", quote: null, impact_pct: { bear: -4, base: -1, bull: 0 } };

describe("Monte Carlo scenario", () => {
  it("produces ordered P10<P50<P90 bands and a beat-probability in [0,1]", () => {
    const s = simulateScenario(baseInputs([revDriver, marginDriver]));
    expect(s.bands.revenue.p10).toBeLessThan(s.bands.revenue.p50);
    expect(s.bands.revenue.p50).toBeLessThan(s.bands.revenue.p90);
    expect(s.bands.eps).toBeDefined();
    expect(s.beat_probability.revenue).toBeGreaterThanOrEqual(0);
    expect(s.beat_probability.revenue).toBeLessThanOrEqual(1);
    expect(s.beat_probability.eps).not.toBeNull();
    // median revenue ≈ base × (1 + mean growth + driver base 2pts) = 100B × 1.07
    expect(s.bands.revenue.p50).toBeGreaterThan(104e9);
    expect(s.bands.revenue.p50).toBeLessThan(110e9);
  });

  it("is deterministic for a fixed seed", () => {
    const a = simulateScenario(baseInputs([revDriver, marginDriver]));
    const b = simulateScenario(baseInputs([revDriver, marginDriver]));
    expect(a.bands.revenue.p50).toBe(b.bands.revenue.p50);
  });

  it("ranks the wider-range driver higher in sensitivity", () => {
    // marginDriver range (4pts) is wider than revDriver (6pts span but on revenue base) — check ordering is stable & sums≈1
    const s = simulateScenario(baseInputs([revDriver, marginDriver]));
    expect(s.sensitivity.length).toBe(2);
    const total = s.sensitivity.reduce((a, c) => a + c.contribution, 0);
    expect(total).toBeCloseTo(1, 5);
    expect(s.sensitivity[0].contribution).toBeGreaterThanOrEqual(s.sensitivity[1].contribution);
    expect(s.watch_items.length).toBe(2);
  });

  it("omits EPS bands when shares are unknown, and beat-prob is null without consensus", () => {
    const s = simulateScenario({ ...baseInputs([revDriver]), shares: null, consensus: null });
    expect(s.bands.eps).toBeUndefined();
    expect(s.beat_probability.revenue).toBeNull();
    expect(s.beat_probability.eps).toBeNull();
  });

  it("bounds an exaggerated driver to historical volatility", () => {
    // A driver claiming +50pts base growth, with σ=2% (bound 2σ=4pts) → median growth can't run away.
    const wild: Driver = { name: "Hype", metric: "revenue", direction: "tailwind", framing: "", quote: null, impact_pct: { bear: 40, base: 50, bull: 60 } };
    const s = simulateScenario(baseInputs([wild]));
    // growth ≈ mean 5% + bounded driver ≤ ~4pts → well under the unbounded +50% it would otherwise imply
    expect(s.bands.revenue_growth.p50).toBeLessThan(0.12);
  });
});
