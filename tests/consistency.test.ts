import { describe, it, expect } from "vitest";
import { checkConsistency, consistencyNote } from "../lib/engines/consistency";
import { summarizeSeries, computeTrends } from "../lib/financials/trends";

describe("checkConsistency", () => {
  it("flags a claim that contradicts a computed fact", () => {
    const f = checkConsistency({ net_debt: true }, "The company has a fortress balance sheet with net cash.");
    expect(f).toHaveLength(1);
    expect(f[0].fact).toBe("net_debt");
  });
  it("catches margin-expansion prose when gross margin is falling", () => {
    const f = checkConsistency({ margin_declining: true }, "We see continued margin expansion into next year.");
    expect(f[0].fact).toBe("margin_declining");
  });
  it("does not fire when the computed fact is false", () => {
    expect(checkConsistency({ net_debt: false }, "net cash and fortress balance sheet")).toHaveLength(0);
  });
  it("does not fire when the prose makes no conflicting claim", () => {
    expect(checkConsistency({ fcf_negative: true, revenue_declining: true }, "Margins compressed and cash burn continued.")).toHaveLength(0);
  });
  it("consistencyNote is empty when clean, instructive when conflicts exist", () => {
    expect(consistencyNote([])).toBe("");
    expect(consistencyNote(checkConsistency({ revenue_declining: true }, "strong revenue growth"))).toMatch(/CONSISTENCY FLAGS/);
  });
});

describe("trends", () => {
  it("summarizeSeries computes mean/stdev/min/max", () => {
    const s = summarizeSeries([0.1, 0.2, 0.3]);
    expect(s.mean).toBeCloseTo(0.2, 5);
    expect(s.min).toBe(0.1);
    expect(s.max).toBe(0.3);
    expect(s.n).toBe(3);
  });
  it("summarizeSeries handles an empty/garbage series", () => {
    expect(summarizeSeries([NaN, Infinity]).n).toBe(0);
    expect(summarizeSeries([]).mean).toBeNull();
  });
  it("flags a new-peak margin vs history (the Micron case)", () => {
    const t = computeTrends([0.1, -0.4, 3.4], [0.3, 0.47, 0.39], 0.68); // current 68% > historical max 47%
    expect(t.margin_vs_peak).toBe("above_peak");
    expect(t.read).toMatch(/NEW peak/);
  });
  it("recognizes a within-range margin", () => {
    expect(computeTrends([0.1], [0.3, 0.5], 0.4).margin_vs_peak).toBe("below_peak");
  });
});
