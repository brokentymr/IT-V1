import { describe, it, expect } from "vitest";
import { checkIdentities } from "./identity";
import type { FinancialModel } from "./model";

// Helper: a line item with an explicit period (durations decide period-consistency).
const li = (value: number, start: string | null, end: string) => ({
  key: "", label: "", value, unit: "USD", period_end: end, period_start: start, fy: null, fp: null, form: null, accession: null, yoy: null,
});

const model = (items: Record<string, ReturnType<typeof li>>): Pick<FinancialModel, "line_items"> => ({ line_items: items as never });

describe("accounting-identity gate", () => {
  it("passes a clean, period-consistent quarter", () => {
    const r = checkIdentities(model({
      revenue: li(41_456e6, "2026-02-27", "2026-05-28"),
      net_income: li(28_243e6, "2026-02-27", "2026-05-28"),
      operating_cash_flow: li(25_390e6, "2026-02-26", "2026-05-28"), // quarterized
      capex: li(9_400e6, "2026-02-26", "2026-05-28"),
      total_assets: li(100_000e6, null, "2026-05-28"),
      total_liabilities: li(40_000e6, null, "2026-05-28"),
      stockholders_equity: li(60_000e6, null, "2026-05-28"),
    }));
    expect(r.ok).toBe(true);
    expect(r.hard).toBe(0);
    expect(r.checks_run).toEqual(expect.arrayContaining(["balance_sheet", "flow_period_consistency", "ocf_le_revenue"]));
  });

  it("catches the Micron defect: a 9-month OCF read as the quarter (period mismatch + OCF>revenue)", () => {
    // The pre-fix extraction: OCF/capex are 9-month YTD while revenue is the 3-month quarter.
    const r = checkIdentities(model({
      revenue: li(41_456e6, "2026-02-27", "2026-05-28"), // 90d
      net_income: li(28_243e6, "2026-02-27", "2026-05-28"), // 90d
      operating_cash_flow: li(45_702e6, "2025-08-29", "2026-05-28"), // 272d YTD — the bug
      capex: li(19_602e6, "2025-08-29", "2026-05-28"), // 272d YTD
    }));
    expect(r.ok).toBe(false);
    expect(r.hard).toBeGreaterThanOrEqual(1);
    // OCF and capex are implicated (off-period); revenue is the reference and stays eligible.
    const implicated = new Set(r.violations.flatMap((v) => v.metrics));
    expect(implicated.has("operating_cash_flow")).toBe(true);
    expect(implicated.has("capex")).toBe(true);
    expect(implicated.has("revenue")).toBe(false);
    // The OCF>revenue check fires HARD because the periods differ (extraction error, not a real anomaly).
    expect(r.violations.some((v) => v.identity === "operating cash flow ≤ revenue" && v.severity === "hard")).toBe(true);
  });

  it("flags a balance sheet that does not tie", () => {
    const r = checkIdentities(model({
      total_assets: li(100_000e6, null, "2026-05-28"),
      total_liabilities: li(40_000e6, null, "2026-05-28"),
      stockholders_equity: li(50_000e6, null, "2026-05-28"), // off by 10B
    }));
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.identity === "assets = liabilities + equity")).toBe(true);
  });

  it("treats a same-period OCF>revenue as soft (needs a cited exception, not a hard stop)", () => {
    const r = checkIdentities(model({
      revenue: li(10_000e6, "2026-02-27", "2026-05-28"),
      operating_cash_flow: li(12_000e6, "2026-02-27", "2026-05-28"), // same 90d period
    }));
    expect(r.ok).toBe(true); // no hard violation
    expect(r.soft).toBeGreaterThanOrEqual(1);
    expect(r.violations.some((v) => v.identity === "operating cash flow ≤ revenue" && v.severity === "soft")).toBe(true);
  });

  it("degrades: skips checks whose inputs are absent (never a fabricated pass)", () => {
    const r = checkIdentities(model({ revenue: li(10_000e6, "2026-02-27", "2026-05-28") }));
    expect(r.ok).toBe(true);
    expect(r.checks_run).not.toContain("balance_sheet");
  });
});
