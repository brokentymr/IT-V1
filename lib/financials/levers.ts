/**
 * Financial levers (pipeline upgrade — grounding the load-bearing claims in primary data).
 *
 * Every number here is computed deterministically from the filing's XBRL figures, so it is citable to
 * the 10-K/10-Q with full confidence — the opposite of a model prior. Two structured reads the desk and
 * the report need:
 *   - ROE levers: a DuPont decomposition (ROE = net margin x asset turnover x equity multiplier) that
 *     shows WHICH lever drives returns and where the company has room to improve.
 *   - Balance-sheet health: liquidity, leverage, interest coverage, cash conversion, and free cash flow.
 * Missing inputs degrade to null — never a fabricated number.
 */

export interface ModelLike {
  line_items: Record<string, { value: number; label?: string }>;
  fiscal_period?: string | null;
}

const val = (m: ModelLike, k: string): number | null => {
  const x = m.line_items[k]?.value;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};
const div = (a: number | null, b: number | null): number | null => (a != null && b != null && b !== 0 ? a / b : null);
const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const x1 = (n: number | null) => (n == null ? "n/a" : `${n.toFixed(2)}x`);

export type LeverKey = "margin" | "turnover" | "leverage";

export interface ROELevers {
  roe: number | null;
  net_margin: number | null;
  asset_turnover: number | null;
  equity_multiplier: number | null;
  driver: LeverKey | null; // the lever most responsible for the ROE level
  improvement_lever: LeverKey | null; // the lever with the most room
  read: string;
}

// Rough cross-sector norms for a single-quarter read (turnover is quarterly, so ~0.25 of annual ~1.0x).
const NORMS = { marginHi: 0.15, marginLo: 0.05, turnoverHi: 0.3, turnoverLo: 0.12, leverageHi: 2.5, leverageLo: 1.5 };

export function computeROELevers(m: ModelLike): ROELevers {
  const ni = val(m, "net_income");
  const rev = val(m, "revenue");
  const assets = val(m, "total_assets");
  const equity = val(m, "stockholders_equity");

  const roe = div(ni, equity);
  const net_margin = div(ni, rev);
  const asset_turnover = div(rev, assets);
  const equity_multiplier = div(assets, equity);

  if (net_margin == null || asset_turnover == null || equity_multiplier == null) {
    return { roe, net_margin, asset_turnover, equity_multiplier, driver: null, improvement_lever: null, read: "Insufficient balance-sheet data for a DuPont decomposition." };
  }

  // Driver = the lever running hot; improvement lever = the one running cold (room to lift ROE).
  const hot: LeverKey | null = net_margin >= NORMS.marginHi ? "margin" : asset_turnover >= NORMS.turnoverHi ? "turnover" : equity_multiplier >= NORMS.leverageHi ? "leverage" : null;
  const cold: LeverKey | null = asset_turnover <= NORMS.turnoverLo ? "turnover" : net_margin <= NORMS.marginLo ? "margin" : equity_multiplier <= NORMS.leverageLo ? "leverage" : null;

  const improveText: Record<LeverKey, string> = {
    margin: "pricing/mix and cost discipline (lift net margin)",
    turnover: "asset utilization — throughput per dollar of assets (lift asset turnover); the business is capital-intensive",
    leverage: "prudent use of the balance sheet (modest leverage) if returns exceed cost of debt",
  };
  const read = `ROE ${pct(roe)} = net margin ${pct(net_margin)} x asset turnover ${x1(asset_turnover)} x equity multiplier ${x1(equity_multiplier)}. `
    + (hot ? `Returns are ${hot}-driven. ` : "No single lever dominates. ")
    + (cold ? `The lever with the most room is ${improveText[cold]}.` : "Levers are balanced; ROE improvement requires lifting margin or turnover, as leverage is already normal.");

  return { roe, net_margin, asset_turnover, equity_multiplier, driver: hot, improvement_lever: cold, read };
}

export type Health = "strong" | "adequate" | "stretched" | "unknown";

export interface BalanceSheetHealth {
  current_ratio: number | null;
  debt_to_equity: number | null;
  net_cash: number | null; // cash - long-term debt; positive = net cash
  interest_coverage: number | null;
  cash_conversion: number | null; // operating cash flow / net income
  free_cash_flow: number | null;
  fcf_margin: number | null;
  health: Health;
  read: string;
}

export function computeBalanceSheetHealth(m: ModelLike): BalanceSheetHealth {
  const cash = val(m, "cash");
  const debt = val(m, "long_term_debt");
  const equity = val(m, "stockholders_equity");
  const ca = val(m, "current_assets");
  const cl = val(m, "current_liabilities");
  const oi = val(m, "operating_income");
  const interest = val(m, "interest_expense");
  const ocf = val(m, "operating_cash_flow");
  const ni = val(m, "net_income");
  const capex = val(m, "capex");
  const rev = val(m, "revenue");

  const current_ratio = div(ca, cl);
  const debt_to_equity = div(debt, equity);
  const net_cash = cash != null && debt != null ? cash - debt : null;
  const interest_coverage = interest != null && interest !== 0 ? div(oi, interest) : null;
  const cash_conversion = div(ocf, ni);
  const free_cash_flow = ocf != null && capex != null ? ocf - capex : null;
  const fcf_margin = div(free_cash_flow, rev);

  // Health: any hard-negative signal → stretched; otherwise strong when the available signals are clean.
  const stretched = (current_ratio != null && current_ratio < 1) || (net_cash != null && net_cash < 0 && (interest_coverage == null || interest_coverage < 3)) || (debt_to_equity != null && debt_to_equity > 2);
  const known = [current_ratio, net_cash, cash_conversion, interest_coverage].some((x) => x != null);
  const strong = !stretched && (current_ratio == null || current_ratio >= 1.5) && (net_cash == null || net_cash >= 0) && (cash_conversion == null || cash_conversion >= 0.8) && (interest_coverage == null || interest_coverage >= 8);
  const health: Health = !known ? "unknown" : stretched ? "stretched" : strong ? "strong" : "adequate";

  const parts: string[] = [];
  if (current_ratio != null) parts.push(`current ratio ${x1(current_ratio)}`);
  if (net_cash != null) parts.push(net_cash >= 0 ? `net cash ${fmtB(net_cash)}` : `net debt ${fmtB(-net_cash)}`);
  if (debt_to_equity != null) parts.push(`debt/equity ${x1(debt_to_equity)}`);
  if (interest_coverage != null) parts.push(`interest coverage ${x1(interest_coverage)}`);
  if (cash_conversion != null) parts.push(`cash conversion ${x1(cash_conversion)} (OCF/NI)`);
  if (free_cash_flow != null) parts.push(`FCF ${fmtB(free_cash_flow)}${fcf_margin != null ? ` (${pct(fcf_margin)} margin)` : ""}`);
  const read = `Balance-sheet health: ${health}. ${parts.join("; ") || "insufficient balance-sheet detail"}.`;

  return { current_ratio, debt_to_equity, net_cash, interest_coverage, cash_conversion, free_cash_flow, fcf_margin, health, read };
}

function fmtB(n: number): string {
  return Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`;
}

export interface Levers {
  roe: ROELevers;
  balance_sheet: BalanceSheetHealth;
}

export function computeLevers(m: ModelLike): Levers {
  return { roe: computeROELevers(m), balance_sheet: computeBalanceSheetHealth(m) };
}

/** Evidence block for the desk — labeled ground truth (computed from the filing's XBRL). */
export function leversBriefing(l: Levers): string {
  return `Financial levers (computed from XBRL — ground truth, citable to the filing):\n- ROE levers: ${l.roe.read}\n- ${l.balance_sheet.read}`;
}
