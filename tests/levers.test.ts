import { describe, it, expect } from "vitest";
import { computeROELevers, computeBalanceSheetHealth, computeWorkingCapital, computeLevers, leversBriefing, type ModelLike } from "../lib/financials/levers";

// Micron Q3 FY2026 real figures (USD).
const micron: ModelLike = {
  line_items: {
    net_income: { value: 28.243e9 }, revenue: { value: 41.456e9 }, total_assets: { value: 134.1e9 },
    stockholders_equity: { value: 100.7e9 }, cash: { value: 25.0e9 }, operating_cash_flow: { value: 45.7e9 },
  },
};

// A fully-populated model exercising every ratio.
const full: ModelLike = {
  line_items: {
    net_income: { value: 10 }, revenue: { value: 100 }, total_assets: { value: 200 }, stockholders_equity: { value: 80 },
    cash: { value: 30 }, long_term_debt: { value: 20 }, current_assets: { value: 60 }, current_liabilities: { value: 40 },
    operating_income: { value: 25 }, interest_expense: { value: 2 }, operating_cash_flow: { value: 15 }, capex: { value: 5 },
  },
};

describe("computeROELevers (DuPont)", () => {
  it("decomposes ROE and the product reconciles", () => {
    const r = computeROELevers(micron);
    expect(r.roe).toBeCloseTo(0.2805, 3);
    expect(r.net_margin).toBeCloseTo(0.6813, 3);
    expect(r.asset_turnover).toBeCloseTo(0.309, 2);
    expect(r.equity_multiplier).toBeCloseTo(1.332, 2);
    // net_margin x asset_turnover x equity_multiplier === ROE
    expect(r.net_margin! * r.asset_turnover! * r.equity_multiplier!).toBeCloseTo(r.roe!, 4);
  });
  it("identifies the driving lever (Micron is margin-driven)", () => {
    expect(computeROELevers(micron).driver).toBe("margin");
    expect(computeROELevers(micron).read).toMatch(/margin-driven/);
  });
  it("identifies turnover as the driver in a capital-light, low-margin model", () => {
    expect(computeROELevers(full).driver).toBe("turnover");
  });
  it("degrades gracefully without balance-sheet data", () => {
    const r = computeROELevers({ line_items: { net_income: { value: 5 }, revenue: { value: 50 } } });
    expect(r.equity_multiplier).toBeNull();
    expect(r.driver).toBeNull();
    expect(r.read).toMatch(/Insufficient/);
  });
});

describe("computeBalanceSheetHealth", () => {
  it("computes the full ratio set and grades a clean sheet strong", () => {
    const b = computeBalanceSheetHealth(full);
    expect(b.current_ratio).toBeCloseTo(1.5, 3);
    expect(b.debt_to_equity).toBeCloseTo(0.25, 3);
    expect(b.net_cash).toBe(10);
    expect(b.interest_coverage).toBeCloseTo(12.5, 3);
    expect(b.cash_conversion).toBeCloseTo(1.5, 3);
    expect(b.free_cash_flow).toBe(10);
    expect(b.health).toBe("strong");
  });
  it("flags a stretched sheet (illiquid + net debt + thin coverage)", () => {
    const stretched: ModelLike = {
      line_items: {
        cash: { value: 5 }, long_term_debt: { value: 60 }, current_assets: { value: 30 }, current_liabilities: { value: 50 },
        operating_income: { value: 4 }, interest_expense: { value: 3 }, stockholders_equity: { value: 40 },
      },
    };
    const b = computeBalanceSheetHealth(stretched);
    expect(b.current_ratio).toBeLessThan(1);
    expect(b.net_cash).toBeLessThan(0);
    expect(b.health).toBe("stretched");
  });
  it("works off partial data (Micron: cash conversion only) without fabricating", () => {
    const b = computeBalanceSheetHealth(micron);
    expect(b.current_ratio).toBeNull();
    expect(b.cash_conversion).toBeCloseTo(1.618, 2);
    expect(b.free_cash_flow).toBeNull();
    expect(["strong", "adequate"]).toContain(b.health);
  });
});

describe("computeWorkingCapital (cash-conversion cycle)", () => {
  const wcModel: ModelLike = {
    line_items: { revenue: { value: 1000 }, cost_of_revenue: { value: 600 }, accounts_receivable: { value: 500 }, inventory: { value: 300 }, accounts_payable: { value: 200 } },
  };
  it("computes DSO/DIO/DPO/CCC for a quarter (91 days)", () => {
    const w = computeWorkingCapital(wcModel, 91);
    expect(w.dso).toBeCloseTo(45.5, 1); // 500/1000*91
    expect(w.dio).toBeCloseTo(45.5, 1); // 300/600*91
    expect(w.dpo).toBeCloseTo(30.33, 1); // 200/600*91
    expect(w.ccc).toBeCloseTo(45.5 + 45.5 - 30.33, 0);
  });
  it("scales with the period length (annual = 365)", () => {
    expect(computeWorkingCapital(wcModel, 365).dso).toBeCloseTo(182.5, 1);
  });
  it("degrades to null without the balance-sheet inputs", () => {
    const w = computeWorkingCapital({ line_items: { revenue: { value: 1000 } } }, 91);
    expect(w.dso).toBeNull();
    expect(w.ccc).toBeNull();
  });
});

describe("leversBriefing", () => {
  it("produces a citable ground-truth block for the desk", () => {
    const b = leversBriefing(computeLevers(full));
    expect(b).toMatch(/ground truth/);
    expect(b).toMatch(/ROE levers/);
    expect(b).toMatch(/Balance-sheet health/);
  });
});
