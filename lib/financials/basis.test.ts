import { describe, it, expect } from "vitest";
import { buildBasisBlock, reconcileBases, scanUnlabeledBasis, type NonGaapReconciliation } from "./basis";
import { computeLevers } from "./levers";
import type { FinancialModel, LineItem } from "./model";

const li = (key: string, label: string, value: number, unit = "USD"): LineItem => ({
  key, label, value, unit, period_end: "2024-06-29", period_start: "2024-03-31",
  fy: 2024, fp: "Q3", form: "10-Q", accession: "acc", basis: "gaap", yoy: null,
});

const model = (over: Partial<Record<string, number>> = {}): FinancialModel => {
  const items: Record<string, LineItem> = {
    revenue: li("revenue", "Revenue", over.revenue ?? 100_000_000_000),
    net_income: li("net_income", "Net income", over.net_income ?? 25_000_000_000),
    operating_cash_flow: li("operating_cash_flow", "Operating cash flow", over.operating_cash_flow ?? 30_000_000_000),
    capex: li("capex", "Capital expenditure", over.capex ?? 8_000_000_000),
    eps_diluted: { ...li("eps_diluted", "Diluted EPS", over.eps_diluted ?? 2.10, "USD/shares") },
  };
  return {
    period_end: "2024-06-29", fiscal_period: "Q3 2024", line_items: items,
    ratios: { gross_margin: 0.42, operating_margin: 0.30, net_margin: 0.25 },
  };
};

const nonGaap = (over: Partial<NonGaapReconciliation> = {}): NonGaapReconciliation => ({
  eps: null, gross_margin: null, operating_margin: null, net_margin: null,
  label: "non-GAAP (company adjusted)", ...over,
});

describe("buildBasisBlock", () => {
  it("labels every line item GAAP", () => {
    const m = model();
    const block = buildBasisBlock(m, computeLevers(m));
    for (const key of Object.keys(m.line_items)) expect(block.line_item_basis[key]).toBe("gaap");
    expect(block.reconciliations).toEqual([]);
    expect(block.unlabeled_flags).toEqual([]);
  });

  it("derives the FCF bridge as OCF − capex (adjusted, company definition)", () => {
    const m = model({ operating_cash_flow: 30e9, capex: 8e9 });
    const block = buildBasisBlock(m, computeLevers(m));
    expect(block.fcf_bridge).toEqual({ ocf: 30e9, capex: 8e9, fcf: 22e9 });
  });

  it("returns a null FCF bridge when OCF or capex is missing", () => {
    const m = model();
    delete m.line_items.capex;
    const block = buildBasisBlock(m, computeLevers(m));
    expect(block.fcf_bridge).toBeNull();
  });
});

describe("reconcileBases", () => {
  it("emits a row when EPS diverges beyond the dollar tolerance", () => {
    const m = model({ eps_diluted: 2.10 });
    const rows = reconcileBases(m, nonGaap({ eps: 2.55 }));
    const eps = rows.find((r) => r.metric === "eps_diluted");
    expect(eps).toBeTruthy();
    expect(eps!.gaap_value).toBe(2.10);
    expect(eps!.non_gaap_value).toBe(2.55);
    expect(eps!.delta).toBeCloseTo(0.45, 5);
    expect(eps!.gaap_label).toBe("GAAP");
    expect(eps!.non_gaap_label).toBe("non-GAAP (company adjusted)");
  });

  it("emits a row when a margin diverges beyond the pp tolerance", () => {
    const m = model();
    const rows = reconcileBases(m, nonGaap({ net_margin: 0.30 })); // 25% GAAP vs 30% non-GAAP
    expect(rows.find((r) => r.metric === "net_margin")).toBeTruthy();
  });

  it("emits no row for pairs equal within tolerance", () => {
    const m = model({ eps_diluted: 2.10 });
    // EPS within $0.01, margin within 0.1pp.
    const rows = reconcileBases(m, nonGaap({ eps: 2.105, net_margin: 0.2505 }));
    expect(rows).toEqual([]);
  });

  it("ignores metrics the filing does not disclose non-GAAP", () => {
    const m = model();
    expect(reconcileBases(m, nonGaap())).toEqual([]);
  });
});

describe("scanUnlabeledBasis", () => {
  it("flags an EPS figure in narrative that differs from GAAP with no basis word", () => {
    const m = model({ eps_diluted: 2.10 });
    const flags = scanUnlabeledBasis("The company delivered EPS of $2.55 this quarter.", m, null);
    expect(flags.length).toBe(1);
    expect(flags[0]).toContain("2.55");
  });

  it("does NOT flag an EPS figure carrying a basis word", () => {
    const m = model({ eps_diluted: 2.10 });
    const flags = scanUnlabeledBasis("Adjusted EPS of $2.55 excludes stock-based comp.", m, null);
    expect(flags).toEqual([]);
  });

  it("does NOT flag an EPS figure that matches the GAAP model value", () => {
    const m = model({ eps_diluted: 2.10 });
    const flags = scanUnlabeledBasis("EPS of $2.10 in the quarter.", m, null);
    expect(flags).toEqual([]);
  });

  it("flags a qualified margin figure differing from GAAP with no basis word", () => {
    const m = model(); // net margin 25%
    const flags = scanUnlabeledBasis("Net margin of 31% reflected strong operating leverage.", m, null);
    expect(flags.length).toBe(1);
    expect(flags[0]).toContain("31%");
  });

  it("annotates when the unlabeled figure matches a disclosed non-GAAP value", () => {
    const m = model({ eps_diluted: 2.10 });
    const flags = scanUnlabeledBasis("EPS of $2.55 this quarter.", m, nonGaap({ eps: 2.55 }));
    expect(flags[0]).toContain("non-GAAP");
  });

  it("returns nothing for empty text", () => {
    expect(scanUnlabeledBasis("", model(), null)).toEqual([]);
    expect(scanUnlabeledBasis(null, model(), null)).toEqual([]);
  });
});
