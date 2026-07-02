import { describe, it, expect } from "vitest";
import { extractStatements, buildModel, diffModels, type FinancialModel } from "./model";
import type { CompanyFacts } from "../sources/sec";

// Minimal XBRL company facts: revenue + cost + net income, current (Q3'24) vs prior-year (Q3'23),
// reported by accession ACC-CURR. A stray un-matched value verifies accession grounding.
const ACC = "0000320193-24-000081";
const facts: CompanyFacts = {
  cik: "0000320193",
  entity_name: "APPLE INC",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [
          { start: "2024-03-31", end: "2024-06-29", val: 85_777_000_000, fy: 2024, fp: "Q3", form: "10-Q", accn: ACC },
          { start: "2023-04-02", end: "2023-07-01", val: 81_797_000_000, fy: 2023, fp: "Q3", form: "10-Q", accn: "old" },
          { start: "2024-06-30", end: "2024-09-28", val: 99_999_000_000, fy: 2024, fp: "Q4", form: "10-K", accn: "later" },
        ] },
      },
      CostOfGoodsAndServicesSold: {
        units: { USD: [
          { start: "2024-03-31", end: "2024-06-29", val: 46_099_000_000, fy: 2024, fp: "Q3", form: "10-Q", accn: ACC },
        ] },
      },
      NetIncomeLoss: {
        units: { USD: [
          { start: "2024-03-31", end: "2024-06-29", val: 21_448_000_000, fy: 2024, fp: "Q3", form: "10-Q", accn: ACC },
          { start: "2023-04-02", end: "2023-07-01", val: 19_881_000_000, fy: 2023, fp: "Q3", form: "10-Q", accn: "old" },
        ] },
      },
    },
  },
};

describe("financial model extraction", () => {
  it("grounds extraction to the filing accession and computes YoY", () => {
    const { line_items, missing } = extractStatements(facts, { accession: ACC });
    // Picks the Q3 value reported by ACC, not the later 10-K value.
    expect(line_items.revenue.value).toBe(85_777_000_000);
    expect(line_items.revenue.accession).toBe(ACC);
    expect(line_items.revenue.yoy?.change_pct).toBeCloseTo((85_777 - 81_797) / 81_797, 5);
    expect(line_items.net_income.value).toBe(21_448_000_000);
    // Concepts absent from the fixture are reported as gaps, not errors.
    expect(missing).toContain("total_assets");
  });

  it("falls back to latest-by-end when no accession is given", () => {
    const { line_items } = extractStatements(facts, {});
    expect(line_items.revenue.value).toBe(99_999_000_000); // latest end (Q4 10-K)
  });

  it("derives gross margin from revenue and cost when GrossProfit is absent", () => {
    const model = buildModel(extractStatements(facts, { accession: ACC }).line_items);
    const expected = (85_777_000_000 - 46_099_000_000) / 85_777_000_000;
    expect(model.ratios.gross_margin).toBeCloseTo(expected, 5);
    expect(model.ratios.net_margin).toBeCloseTo(21_448 / 85_777, 4);
    expect(model.fiscal_period).toBe("Q3 2024");
  });
});

describe("snapshot diff", () => {
  it("computes per-metric direction and pct vs the prior snapshot", () => {
    const curr = buildModel(extractStatements(facts, { accession: ACC }).line_items);
    const prev: FinancialModel = {
      period_end: "2024-03-30", fiscal_period: "Q2 2024",
      line_items: { revenue: { ...curr.line_items.revenue, value: 80_000_000_000 } } as never,
      ratios: { gross_margin: 0.45 },
    };
    const d = diffModels(prev, curr);
    const rev = d.metrics.find((m) => m.key === "revenue")!;
    expect(rev.direction).toBe("up");
    expect(rev.change).toBe(85_777_000_000 - 80_000_000_000);
    expect(d.ratios.gross_margin.change).toBeCloseTo(curr.ratios.gross_margin - 0.45, 5);
    // net_income has no prior → marked "new"
    expect(d.metrics.find((m) => m.key === "net_income")!.direction).toBe("new");
  });

  it("treats a re-run (identical model) as flat with no prior on first snapshot", () => {
    const curr = buildModel(extractStatements(facts, { accession: ACC }).line_items);
    const first = diffModels(null, curr);
    expect(first.metrics.every((m) => m.direction === "new")).toBe(true);
    const second = diffModels(curr, curr);
    expect(second.metrics.find((m) => m.key === "revenue")!.direction).toBe("flat");
  });
});

// Regression for the Micron (MU) audit F1: a 10-Q cash-flow statement reports OCF as fiscal-YTD, so a
// Q3 filing's OCF is the 9-month cumulative. Extraction must isolate the QUARTER (9-month − 6-month),
// not read the YTD figure as the quarter. Vectors are Micron's real FY2026 XBRL periods.
const MU_ACC = "0000723125-26-000015";
const muFacts: CompanyFacts = {
  cik: "0000723125",
  entity_name: "MICRON TECHNOLOGY INC",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [
          { start: "2025-08-29", end: "2026-02-26", val: 37_500_000_000, fy: 2026, fp: "Q2", form: "10-Q", accn: MU_ACC }, // 6-mo YTD
          { start: "2025-08-29", end: "2026-05-28", val: 78_960_000_000, fy: 2026, fp: "Q3", form: "10-Q", accn: MU_ACC }, // 9-mo YTD
          { start: "2026-02-27", end: "2026-05-28", val: 41_456_000_000, fy: 2026, fp: "Q3", form: "10-Q", accn: MU_ACC }, // the quarter
          { start: "2025-02-28", end: "2025-05-29", val: 9_301_000_000, fy: 2025, fp: "Q3", form: "10-Q", accn: "prior" }, // prior-year quarter
        ] },
      },
      NetCashProvidedByUsedInOperatingActivities: {
        // Cash-flow statement: YTD only — no 3-month value exists, so the quarter must be derived.
        units: { USD: [
          { start: "2025-08-29", end: "2026-02-26", val: 20_310_000_000, fy: 2026, fp: "Q2", form: "10-Q", accn: MU_ACC }, // 6-mo YTD
          { start: "2025-08-29", end: "2026-05-28", val: 45_702_000_000, fy: 2026, fp: "Q3", form: "10-Q", accn: MU_ACC }, // 9-mo YTD (the trap)
          { start: "2024-08-30", end: "2025-02-27", val: 7_190_000_000, fy: 2025, fp: "Q2", form: "10-Q", accn: "prior" }, // prior 6-mo YTD
          { start: "2024-08-30", end: "2025-05-29", val: 11_795_000_000, fy: 2025, fp: "Q3", form: "10-Q", accn: "prior" }, // prior 9-mo YTD
        ] },
      },
    },
  },
};

describe("period-consistent flow extraction (MU quarterization)", () => {
  const { line_items } = extractStatements(muFacts, { accession: MU_ACC });

  it("keeps the directly-tagged 3-month revenue as the quarter", () => {
    expect(line_items.revenue.value).toBe(41_456_000_000);
    expect(line_items.revenue.period_start).toBe("2026-02-27");
    expect(line_items.revenue.period_end).toBe("2026-05-28");
    // YoY laps the prior-year 3-month quarter, not a YTD figure.
    expect(line_items.revenue.yoy?.change_pct).toBeCloseTo((41_456 - 9_301) / 9_301, 4);
  });

  it("derives the OCF quarter by subtracting the prior YTD (9-month − 6-month = $25.39B)", () => {
    expect(line_items.operating_cash_flow.value).toBe(45_702_000_000 - 20_310_000_000); // 25.392B — NOT 45.7B
    expect(line_items.operating_cash_flow.period_start).toBe("2026-02-26"); // the quarter, not the fiscal year
    expect(line_items.operating_cash_flow.period_end).toBe("2026-05-28");
  });

  it("computes OCF YoY from quarterized figures on both sides (not 9-mo vs 9-mo)", () => {
    // The bug produced +287% by comparing a 9-month current to a 9-month prior, both mislabeled Q3.
    const priorQuarter = 11_795_000_000 - 7_190_000_000; // 4.605B
    expect(line_items.operating_cash_flow.yoy?.prior_value).toBe(priorQuarter);
    expect(line_items.operating_cash_flow.yoy?.change_pct).not.toBeCloseTo(2.875, 2); // the old bogus +287%
  });

  it("leaves OCF ≤ revenue once quarterized (the identity that the raw YTD figure violated)", () => {
    expect(line_items.operating_cash_flow.value).toBeLessThan(line_items.revenue.value);
  });
});

describe("demand-visibility extraction (Layer 1: RPO + contract liabilities)", () => {
  const ACC = "0000723125-26-000015";
  const facts: CompanyFacts = {
    cik: "0000723125", entity_name: "MICRON TECHNOLOGY INC",
    facts: { "us-gaap": {
      // ASC 606 RPO is an instant (stock) balance as of period end — no start.
      RevenueRemainingPerformanceObligation: { units: { USD: [
        { end: "2026-05-28", val: 5_000_000_000, fy: 2026, fp: "Q3", form: "10-Q", accn: ACC },
      ] } },
      ContractWithCustomerLiabilityCurrent: { units: { USD: [
        { end: "2026-05-28", val: 420_000_000, fy: 2026, fp: "Q3", form: "10-Q", accn: ACC },
      ] } },
    } },
  };

  it("extracts RPO as a grounded, GAAP-labeled stock figure", () => {
    const { line_items } = extractStatements(facts, { accession: ACC });
    expect(line_items.remaining_performance_obligation.value).toBe(5_000_000_000);
    expect(line_items.remaining_performance_obligation.basis).toBe("gaap");
    expect(line_items.remaining_performance_obligation.label).toMatch(/ASC 606/);
    expect(line_items.contract_liabilities.value).toBe(420_000_000);
  });
});
