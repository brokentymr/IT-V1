import { describe, it, expect } from "vitest";
import { panelDivergence, divergenceNote, claimsDigest, type LensLike } from "../lib/engines/adjudication";

// The Micron panel: sector confident (0.74) while risk/equity reject (0.41) — a real disagreement.
const micronPanel: LensLike[] = [
  { lens: "equity", confidence: 0.41, claims: [{ statement: "figures likely aggregate multiple periods", grounded: false, confidence: 0.82 }] },
  { lens: "sector", confidence: 0.74, claims: [{ statement: "84.6% margin is genuine mix-shift", grounded: false, confidence: 0.82 }] },
  { lens: "technology", confidence: 0.62, claims: [] },
  { lens: "risk", confidence: 0.41, claims: [{ statement: "figures are a data error", grounded: true, confidence: 0.91 }] },
];

describe("panelDivergence", () => {
  it("flags a material spread across the lenses", () => {
    const d = panelDivergence(micronPanel);
    expect(d.spread).toBeCloseTo(0.33, 2);
    expect(d.highest?.lens).toBe("sector");
    expect(d.lowest?.confidence).toBe(0.41);
    expect(d.diverges).toBe(true);
  });
  it("does not flag an aligned panel", () => {
    const d = panelDivergence([{ lens: "a", confidence: 0.7 }, { lens: "b", confidence: 0.75 }]);
    expect(d.diverges).toBe(false);
  });
  it("is a no-op for a single lens", () => {
    expect(panelDivergence([{ lens: "a", confidence: 0.5 }]).diverges).toBe(false);
  });
});

describe("divergenceNote", () => {
  it("instructs the synthesizer to rule, not average, when lenses disagree", () => {
    const n = divergenceNote(micronPanel);
    expect(n).toMatch(/Do NOT average/);
    expect(n).toMatch(/RULE on it/);
    expect(n).toContain("sector"); // the highest-confidence lens
    expect(n).toContain("41%"); // the lowest-confidence lens's number
  });
  it("returns empty when the panel is aligned", () => {
    expect(divergenceNote([{ lens: "a", confidence: 0.7 }, { lens: "b", confidence: 0.72 }])).toBe("");
  });
});

describe("claimsDigest", () => {
  it("tags each claim grounded vs prior so fact disputes are visible", () => {
    const d = claimsDigest(micronPanel);
    expect(d).toContain("[prior, 82%]");
    expect(d).toContain("[grounded, 91%]");
    expect(d).toContain("sector");
  });
});
