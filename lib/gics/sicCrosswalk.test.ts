import { describe, it, expect } from "vitest";
import { classifyFromSic } from "./taxonomy";

describe("SIC → GICS crosswalk", () => {
  const cases: Array<[string, string, string | null]> = [
    ["3571", "Information Technology", "Technology Hardware & Equipment"],   // AAPL
    ["3570", "Information Technology", "Technology Hardware & Equipment"],   // HPQ (boundary)
    ["3674", "Information Technology", "Semiconductors & Semiconductor Equipment"],
    ["7372", "Information Technology", "Software & Services"],
    ["2834", "Health Care", "Pharmaceuticals, Biotechnology & Life Sciences"],
    ["6022", "Financials", "Banks"],
    ["6798", "Real Estate", "Equity Real Estate Investment Trusts (REITs)"],
    ["4911", "Utilities", "Utilities"],
    ["1311", "Energy", "Energy"],
  ];
  it.each(cases)("SIC %s → %s / %s (high confidence)", (sic, sector, group) => {
    const c = classifyFromSic(sic);
    expect(c.gics_sector).toBe(sector);
    expect(c.industry_group).toBe(group);
    expect(c.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("falls back to sector-only at medium confidence for a 2-digit major-group match", () => {
    const c = classifyFromSic("3312"); // steel works → major group 33 → Materials
    expect(c.gics_sector).toBe("Materials");
    expect(c.industry_group).toBeNull();
    expect(c.confidence).toBeCloseTo(0.6, 5);
  });

  it("returns a null sector and low confidence for an unclassifiable SIC", () => {
    const c = classifyFromSic("9995");
    expect(c.gics_sector).toBeNull();
    expect(c.confidence).toBeLessThan(0.3);
  });

  it("handles missing SIC", () => {
    const c = classifyFromSic(null);
    expect(c.gics_sector).toBeNull();
    expect(c.confidence).toBe(0);
  });
});
