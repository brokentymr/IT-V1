import { describe, it, expect } from "vitest";
import { detectSurprises, surpriseBriefing, type Observation } from "../lib/engines/surprise";

const yoy = (key: string, label: string, current: number, baseline: number): Observation =>
  ({ key, label, current, baseline, baselineSource: "prior-year", kind: "yoy_growth", unit: "USD" });

describe("detectSurprises", () => {
  it("flags the Micron case (extreme growth) instead of ignoring it", () => {
    // Revenue $41.5B vs prior-year ~$9.3B → +346%.
    const s = detectSurprises([yoy("rev", "Revenue YoY", 41.5e9, 9.3e9)]);
    expect(s).toHaveLength(1);
    expect(s[0].magnitude).toBe("extreme");
    expect(s[0].direction).toBe("up");
    expect(s[0].deltaPct).toBeGreaterThan(3);
  });

  it("scores margins in percentage points, not relative change", () => {
    // 39% → 84.6% gross margin = +45.6pts → extreme.
    const s = detectSurprises([
      { key: "gm", label: "Gross margin", current: 0.846, baseline: 0.39, baselineSource: "prior snapshot", kind: "margin_pp", unit: "ratio" },
    ]);
    expect(s[0].magnitude).toBe("extreme");
    expect(s[0].deltaPp).toBeCloseTo(45.6, 1);
    expect(s[0].deltaPct).toBeNull();
  });

  it("classifies magnitude by threshold and filters normal moves", () => {
    const s = detectSurprises([
      yoy("a", "A", 110, 100), // +10% → normal, filtered
      yoy("b", "B", 125, 100), // +25% → notable
      yoy("c", "C", 160, 100), // +60% → large
      yoy("d", "D", 300, 100), // +200% → extreme
    ]);
    expect(s.map((x) => x.key)).toEqual(["d", "c", "b"]); // sorted, normal dropped
    expect(s.map((x) => x.magnitude)).toEqual(["extreme", "large", "notable"]);
  });

  it("treats a nonzero value off a zero baseline as extreme, and flags declines", () => {
    const zero = detectSurprises([yoy("z", "Z", 500, 0)]);
    expect(zero[0].magnitude).toBe("extreme");
    const drop = detectSurprises([yoy("rev", "Revenue YoY", 51, 100)]); // -49% downturn
    expect(drop[0].direction).toBe("down");
    expect(drop[0].magnitude).toBe("large");
  });

  it("ignores non-finite inputs", () => {
    expect(detectSurprises([yoy("n", "N", NaN, 100)])).toHaveLength(0);
  });

  it("scores a consensus beat relatively", () => {
    const s = detectSurprises([
      { key: "eps", label: "EPS vs consensus", current: 25.11, baseline: 21.39, baselineSource: "consensus", kind: "vs_consensus", unit: "USD/shares" },
    ]);
    expect(s[0].magnitude).toBe("notable"); // ~17% beat
    expect(s[0].direction).toBe("up");
  });
});

describe("surpriseBriefing", () => {
  it("returns empty string on a quiet quarter (no large/extreme moves)", () => {
    const s = detectSurprises([yoy("a", "A", 118, 100)]); // notable only
    expect(surpriseBriefing(s)).toBe("");
  });

  it("instructs the desk to treat surprises as real and explains each", () => {
    const s = detectSurprises([yoy("rev", "Revenue YoY", 41.5e9, 9.3e9)]);
    const b = surpriseBriefing(s);
    expect(b).toContain("DO NOT DISMISS");
    expect(b).toContain("treat");
    expect(b).toContain("Revenue YoY");
    expect(b).toMatch(/analytical failure/i);
  });
});
