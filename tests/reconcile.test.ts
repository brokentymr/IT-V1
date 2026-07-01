import { describe, it, expect } from "vitest";
import { reconcileScenario, type DriverLike } from "../lib/financials/reconcile";

const d = (metric: string, bear: number, base: number, bull: number): DriverLike => ({ metric, impact_pct: { bear, base, bull } });

// Micron's revenue drivers: HBM (+5/+12/+20), export controls (-15/-6/-2), AI content (+3/+8/+15).
const micronRevenueDrivers = [d("revenue", 5, 12, 20), d("revenue", -15, -6, -2), d("revenue", 3, 8, 15), d("gross_margin", -4, 2, 5)];

describe("reconcileScenario", () => {
  it("sums only the revenue drivers into an implied growth range", () => {
    const c = reconcileScenario(micronRevenueDrivers, { p10: -0.1, p50: 0.14, p90: 0.4 });
    expect(c.driverImpliedGrowthPct).toEqual({ bear: -7, base: 14, bull: 33 }); // gross_margin driver excluded
  });

  it("calls it coherent when drivers and the MC median agree", () => {
    const c = reconcileScenario(micronRevenueDrivers, { p10: -0.1, p50: 0.14, p90: 0.4 });
    expect(c.agree).toBe(true);
    expect(c.note).toMatch(/coherent/i);
  });

  it("flags incoherence when the MC median sits far outside the driver range (the Micron disconnect)", () => {
    // Drivers imply +14% base; MC P50 +28% while the driver bull is only +33% — but here push MC to +80%.
    const c = reconcileScenario(micronRevenueDrivers, { p10: -0.52, p50: 0.8, p90: 1.2 });
    expect(c.agree).toBe(false);
    expect(c.note).toMatch(/INCOHERENT/);
  });

  it("flags incoherence on opposite direction", () => {
    const c = reconcileScenario([d("revenue", -10, -5, 0)], { p10: 0.1, p50: 0.3, p90: 0.5 });
    expect(c.agree).toBe(false);
    expect(c.note).toMatch(/opposite direction/);
  });

  it("no-ops (agree) when inputs are insufficient", () => {
    expect(reconcileScenario([], { p10: 0, p50: 0.1, p90: 0.2 }).agree).toBe(true);
    expect(reconcileScenario(micronRevenueDrivers, null).agree).toBe(true);
  });
});
