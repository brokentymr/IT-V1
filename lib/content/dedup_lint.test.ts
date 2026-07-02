import { describe, it, expect } from "vitest";
import { extractNumericTokens, normalizeNumeric, lintAssembledReport } from "./dedup_lint";
import { CONTENT_LINT_CONFIG } from "../config/content";

describe("dedup_lint.extractNumericTokens", () => {
  it("pulls currency, percentages, bands, probabilities, and large integers", () => {
    const toks = extractNumericTokens("Revenue $85.0B up 5.0%, P50 band, P(beat) 0.53, 21000000 units, EPS $1.50");
    expect(toks).toContain("$85.0B");
    expect(toks).toContain("5.0%");
    expect(toks).toContain("P50");
    expect(toks).toContain("0.53");
    expect(toks).toContain("$1.50");
    expect(toks).toContain("21000000");
  });

  it("does not double-count a currency figure's digits as a plain integer", () => {
    const toks = extractNumericTokens("$85B");
    expect(toks).toEqual(["$85B"]);
  });

  it("handles thousands separators inside currency", () => {
    expect(extractNumericTokens("$1,200M")).toEqual(["$1,200M"]);
  });
});

describe("dedup_lint.normalizeNumeric", () => {
  it("collapses trailing-zero renderings so $85.0B ≡ $85B", () => {
    expect(normalizeNumeric("$85.0B")).toBe(normalizeNumeric("$85B"));
  });
  it("strips commas and lowercases", () => {
    expect(normalizeNumeric("$1,200M")).toBe("$1200m");
  });
  it("trims trailing zeros in a fraction but keeps significant decimals", () => {
    expect(normalizeNumeric("1.50")).toBe("1.5");
    expect(normalizeNumeric("0.530")).toBe("0.53");
    expect(normalizeNumeric("5.0%")).toBe("5%");
  });
});

describe("dedup_lint.lintAssembledReport", () => {
  it("flags a number repeated more than maxNumericRepeats across sections", () => {
    const rep = lintAssembledReport([
      { label: "deck", text: "Revenue $85.0B." },
      { label: "newsletter", text: "Again $85B and $85.0B here." },
    ], CONTENT_LINT_CONFIG);
    const finding = rep.findings.find((f) => f.token === "$85b");
    expect(finding).toBeDefined();
    expect(finding!.count).toBe(3);
    expect(finding!.sections.sort()).toEqual(["deck", "newsletter"]);
    expect(rep.flaggedCount).toBeGreaterThan(0);
  });

  it("does not flag a number at or below the threshold", () => {
    const rep = lintAssembledReport([
      { label: "deck", text: "$85.0B" },
      { label: "newsletter", text: "$85B" },
    ], CONTENT_LINT_CONFIG);
    expect(rep.findings.find((f) => f.token === "$85b")).toBeUndefined();
  });

  it("ignores calendar years, small integers, and configured tokens", () => {
    const rep = lintAssembledReport([
      { label: "a", text: "2026 2026 2026 fiscal years, and 5 5 5 items, and 1 1 1." },
      { label: "b", text: "2026 and 5 and 1." },
    ], CONTENT_LINT_CONFIG);
    expect(rep.findings).toEqual([]);
  });
});
