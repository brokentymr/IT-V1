import { describe, it, expect } from "vitest";
import { DemandProfile, CustomerNote, demandBriefing } from "../lib/engines/fundamentals_analyst";

describe("DemandProfile schema", () => {
  it("fills safe defaults for a sparse extraction", () => {
    const d = DemandProfile.parse({ customers: [{ name: "NVIDIA" }], customer_concentration: "one customer >10%" });
    expect(d.customers[0].reliability).toBe("unknown");
    expect(d.customers[0].share_pct).toBeNull();
    expect(d.segments).toEqual([]);
    expect(d.demand_signals).toBe("");
  });
  it("rejects an invalid reliability enum", () => {
    expect(() => CustomerNote.parse({ name: "X", reliability: "great" })).toThrow();
  });
});

describe("demandBriefing", () => {
  it("renders a citable demand block with customers, concentration, and signals", () => {
    const d = DemandProfile.parse({
      customers: [{ name: "NVIDIA", share_pct: 20, reliability: "cyclical", relationship: "HBM3E" }, { name: "Microsoft", reliability: "reliable" }],
      customer_concentration: "top 3 ≈ 45% of revenue",
      segments: [{ name: "Datacenter", revenue_share_pct: 56, trend: "up" }],
      demand_signals: "HBM sold out through CY2026",
      supply_constraints: "TSV capacity constrained",
    });
    const b = demandBriefing(d);
    expect(b).toMatch(/ground truth/);
    expect(b).toContain("NVIDIA (20%) [cyclical]");
    expect(b).toContain("top 3 ≈ 45%");
    expect(b).toContain("Datacenter 56%");
    expect(b).toContain("sold out through CY2026");
  });
  it("returns empty string when nothing was extracted", () => {
    expect(demandBriefing(DemandProfile.parse({}))).toBe("");
  });
});
