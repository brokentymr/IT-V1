import { describe, it, expect } from "vitest";
import { extractNumbers, buildVerifiedClaims, quarantineText, type VerifiedClaim } from "./numeric";
import { PROVENANCE_CONFIG } from "../config/provenance";
import type { FinancialModel } from "../financials/model";
import type { ScenarioOutput } from "../financials/montecarlo";
import type { Levers } from "../financials/levers";

describe("extractNumbers — magnitude normalization", () => {
  it("normalizes currency magnitude suffixes to absolute dollars", () => {
    expect(extractNumbers("$18B")[0]).toMatchObject({ value: 18e9, kind: "currency", unit: "USD" });
    expect(extractNumbers("$41.5 billion")[0]).toMatchObject({ value: 41.5e9, kind: "currency" });
    expect(extractNumbers("$5,700M")[0]).toMatchObject({ value: 5.7e9, kind: "currency" });
    expect(extractNumbers("$5")[0]).toMatchObject({ value: 5, kind: "currency" });
  });

  it("classifies percents and ratios distinctly from currency", () => {
    expect(extractNumbers("84.6%")[0]).toMatchObject({ value: 84.6, kind: "percent", unit: "%" });
    expect(extractNumbers("10%")[0]).toMatchObject({ value: 10, kind: "percent" });
    expect(extractNumbers("trading at 2.5x book")[0]).toMatchObject({ value: 2.5, kind: "ratio", unit: "x" });
  });

  it("excludes years, form types, and conviction ratios", () => {
    expect(extractNumbers("filed in 2026")).toEqual([]);
    expect(extractNumbers("per the 10-Q and 10-K and 8-K")).toEqual([]);
    expect(extractNumbers("conviction 5/5")).toEqual([]);
  });

  it("returns [] for number-free text", () => {
    expect(extractNumbers("Margin compression accelerates")).toEqual([]);
    expect(extractNumbers("")).toEqual([]);
  });

  it("finds multiple tokens across a sentence and keeps a comma-grouped year out", () => {
    const toks = extractNumbers("Revenue falls below $80B and net margin under 22% in 2026");
    expect(toks.map((t) => t.kind)).toEqual(["currency", "percent"]);
    expect(toks[0].value).toBe(80e9);
    expect(toks[1].value).toBe(22);
  });
});

const model: FinancialModel = {
  period_end: "2024-06-29",
  fiscal_period: "Q3 2024",
  line_items: {
    revenue: { key: "revenue", label: "Revenue", value: 85_777_000_000, unit: "USD", period_end: "2024-06-29", period_start: "2024-03-31", fy: 2024, fp: "Q3", form: "10-Q", accession: "acc", basis: "gaap", yoy: null },
    net_income: { key: "net_income", label: "Net Income", value: 21_448_000_000, unit: "USD", period_end: "2024-06-29", period_start: "2024-03-31", fy: 2024, fp: "Q3", form: "10-Q", accession: "acc", basis: "gaap", yoy: null },
  },
  ratios: { net_margin: 0.25 },
};

describe("buildVerifiedClaims", () => {
  it("emits one located, verified claim per line item + ratio", () => {
    const claims = buildVerifiedClaims(model, null, null);
    expect(claims.find((c) => c.source_locator === "xbrl:revenue")?.value).toBe(85_777_000_000);
    expect(claims.find((c) => c.source_locator === "xbrl:net_income")?.value).toBe(21_448_000_000);
    expect(claims.find((c) => c.source_locator === "xbrl:net_margin")?.value).toBe(0.25);
    expect(claims.every((c) => c.verified === true)).toBe(true);
  });

  it("includes scenario bands and lever figures, skipping nulls", () => {
    const scenario = { bands: { revenue: { p10: 80e9, p50: 90e9, p90: 100e9 } } } as unknown as ScenarioOutput;
    const levers = {
      roe: { roe: 0.3, net_margin: 0.25, asset_turnover: null, equity_multiplier: null },
      balance_sheet: { free_cash_flow: 20e9, net_cash: 50e9, current_ratio: null, debt_to_equity: null, interest_coverage: null, cash_conversion: null, fcf_margin: null },
      working_capital: { dso: null, dio: null, dpo: null, ccc: null },
    } as unknown as Levers;
    const claims = buildVerifiedClaims(null, scenario, levers);
    expect(claims.some((c) => c.source_locator === "scenario:revenue" && c.value === 90e9)).toBe(true);
    expect(claims.some((c) => c.source_locator === "levers:free_cash_flow" && c.value === 20e9)).toBe(true);
    expect(claims.some((c) => c.source_locator === "levers:asset_turnover")).toBe(false); // null skipped
  });

  it("degrades to [] with all null inputs", () => {
    expect(buildVerifiedClaims(null, null, null)).toEqual([]);
  });
});

describe("quarantineText", () => {
  const verified: VerifiedClaim[] = [
    { value: 85_777_000_000, unit: "USD", source_locator: "xbrl:revenue", verified: true },
  ];

  it("admits percent/ratio thresholds and number-free triggers", () => {
    const r = quarantineText(
      ["Net margin < 22% for two quarters", "Loss of the anchor customer", "Multiple compresses below 2x"],
      verified,
      PROVENANCE_CONFIG,
    );
    expect(r.quarantined).toEqual([]);
    expect(r.admitted.length).toBe(3);
  });

  it("admits forward currency thresholds within model scale (they need not match a current figure)", () => {
    const r = quarantineText(
      ["Revenue falls to $50B next quarter", "Revenue drops below $85.8B"],
      verified,
      PROVENANCE_CONFIG,
    );
    // $50B is a legitimate forward bar (not a current value), $85.8B restates the XBRL figure — both admit.
    expect(r.quarantined).toEqual([]);
    expect(r.admitted).toEqual(["Revenue falls to $50B next quarter", "Revenue drops below $85.8B"]);
  });

  it("quarantines a currency figure implausible vs the model scale", () => {
    // $85.777B model -> ceiling = 10x ≈ $857.8B; $2T is out of scale (fabricated), a $200B bar is not.
    const r = quarantineText(
      ["Revenue collapses to $2 trillion next quarter", "Revenue grows to $200B"],
      verified,
      PROVENANCE_CONFIG,
    );
    expect(r.quarantined).toEqual(["Revenue collapses to $2 trillion next quarter"]);
    expect(r.admitted).toEqual(["Revenue grows to $200B"]);
  });

  it("holds out a currency threshold when there is no currency claim to anchor scale", () => {
    const r = quarantineText(["Revenue falls to $50B"], [], PROVENANCE_CONFIG);
    expect(r.quarantined).toEqual(["Revenue falls to $50B"]);
    expect(r.admitted).toEqual([]);
  });

  it("empty triggers -> {admitted:[],quarantined:[]}", () => {
    expect(quarantineText([], verified, PROVENANCE_CONFIG)).toEqual({ admitted: [], quarantined: [] });
  });

  it("respects an empty barredKinds config (nothing quarantined)", () => {
    const cfg = { ...PROVENANCE_CONFIG, barredKinds: [] };
    const r = quarantineText(["Revenue falls to $50B"], verified, cfg);
    expect(r.quarantined).toEqual([]);
    expect(r.admitted).toEqual(["Revenue falls to $50B"]);
  });
});
