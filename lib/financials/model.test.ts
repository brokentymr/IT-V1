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
