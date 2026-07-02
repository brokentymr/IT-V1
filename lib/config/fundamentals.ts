/**
 * Fundamental Research (Engine 2) configuration — config-not-code (spec §4.2, like the monitor
 * rubric). Tunable without a rebuild: which forms trigger coverage, how early the forward pass
 * fires, and the XBRL concept tags we extract. Tag lists are ordered fallbacks because issuers
 * tag the same line item with different us-gaap concepts.
 */
export interface MetricSpec {
  key: string;
  label: string;
  tags: string[];          // ordered us-gaap concept fallbacks
  unit: string;            // XBRL unit key (most are USD; per-share metrics differ)
  kind: "flow" | "stock";  // duration (income/cash-flow) vs instant (balance sheet)
}

export interface FundamentalsConfig {
  /** Forms whose arrival triggers a coverage pass. */
  triggerForms: string[];
  /** Forward pass fires when next_earnings_date is within this many days. */
  forwardLeadDays: number;
  /** Filing-document text budget for grounded link enrichment (chars). */
  linkTextBudget: number;
  /** MD&A section text budget for driver extraction (chars). */
  mdaTextBudget: number;
  /** Monte Carlo scenario parameters (Phase-4 improvement #4). */
  montecarlo: {
    runs: number;          // simulation count
    boundSigma: number;    // hybrid bound: a driver's impact is clamped to ±boundSigma×historical σ
    sensitivityTopN: number; // drivers surfaced as watch-items
    historyPeriods: number;  // periods of XBRL history used to estimate volatility
    seed: number;          // RNG seed for reproducibility (override per-run if needed)
  };
  /** Line items extracted from XBRL company facts. */
  metrics: MetricSpec[];
}

export const FUNDAMENTALS_CONFIG: FundamentalsConfig = {
  triggerForms: ["10-K", "10-Q", "8-K", "S-1"],
  forwardLeadDays: 10,
  linkTextBudget: 24_000,
  mdaTextBudget: 18_000,
  montecarlo: { runs: 10_000, boundSigma: 2, sensitivityTopN: 3, historyPeriods: 12, seed: 1_234_567 },
  metrics: [
    { key: "revenue", label: "Revenue", unit: "USD", kind: "flow",
      tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"] },
    { key: "cost_of_revenue", label: "Cost of revenue", unit: "USD", kind: "flow",
      tags: ["CostOfGoodsAndServicesSold", "CostOfRevenue"] },
    { key: "gross_profit", label: "Gross profit", unit: "USD", kind: "flow", tags: ["GrossProfit"] },
    { key: "operating_income", label: "Operating income", unit: "USD", kind: "flow", tags: ["OperatingIncomeLoss"] },
    { key: "net_income", label: "Net income", unit: "USD", kind: "flow", tags: ["NetIncomeLoss", "ProfitLoss"] },
    { key: "eps_diluted", label: "Diluted EPS", unit: "USD/shares", kind: "flow", tags: ["EarningsPerShareDiluted"] },
    { key: "operating_cash_flow", label: "Operating cash flow", unit: "USD", kind: "flow",
      tags: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
    { key: "total_assets", label: "Total assets", unit: "USD", kind: "stock", tags: ["Assets"] },
    { key: "total_liabilities", label: "Total liabilities", unit: "USD", kind: "stock", tags: ["Liabilities"] },
    { key: "stockholders_equity", label: "Stockholders' equity", unit: "USD", kind: "stock",
      tags: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
    { key: "cash", label: "Cash & equivalents", unit: "USD", kind: "stock",
      tags: ["CashAndCashEquivalentsAtCarryingValue"] },
    // Balance-sheet health + ROE levers (pipeline upgrade): liquidity, leverage, coverage, free cash flow.
    { key: "current_assets", label: "Current assets", unit: "USD", kind: "stock", tags: ["AssetsCurrent"] },
    { key: "current_liabilities", label: "Current liabilities", unit: "USD", kind: "stock", tags: ["LiabilitiesCurrent"] },
    { key: "long_term_debt", label: "Long-term debt", unit: "USD", kind: "stock", tags: ["LongTermDebtNoncurrent", "LongTermDebt"] },
    { key: "capex", label: "Capital expenditure", unit: "USD", kind: "flow", tags: ["PaymentsToAcquirePropertyPlantAndEquipment"] },
    { key: "interest_expense", label: "Interest expense", unit: "USD", kind: "flow", tags: ["InterestExpense", "InterestExpenseNonoperating"] },
    // Working-capital / cash-conversion cycle (grounding v2 W5): receivables, inventory, payables.
    { key: "accounts_receivable", label: "Accounts receivable", unit: "USD", kind: "stock", tags: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"] },
    { key: "inventory", label: "Inventory", unit: "USD", kind: "stock", tags: ["InventoryNet"] },
    { key: "accounts_payable", label: "Accounts payable", unit: "USD", kind: "stock", tags: ["AccountsPayableCurrent", "AccountsPayableTradeCurrent"] },
  ],
};

/**
 * Basis labeling (control P11 — GAAP / non-GAAP / adjusted). Config-not-code: every reported figure
 * is stamped with the reporting basis so a non-GAAP number can never be silently read as GAAP.
 *   - defaultBasis: XBRL us-gaap line items are, by definition, GAAP.
 *   - derivedBasis: figures WE derive that the company defines its own way (e.g. free cash flow =
 *     operating cash flow − capex) carry the company-definition adjusted label, not GAAP.
 *   - divergence tolerances: a GAAP vs non-GAAP figure is only reconciled (surfaced as a delta) when it
 *     diverges beyond these floors — equal-within-tolerance pairs produce NO reconciliation row.
 *   - displayLabels: how each basis reads in the UI / consumables.
 */
export interface BasisConfig {
  defaultBasis: "gaap" | "non_gaap" | "adjusted" | "unadjusted";
  derivedBasis: Record<string, { basis: "gaap" | "non_gaap" | "adjusted" | "unadjusted"; label: string }>;
  epsDivergenceUsd: number;   // EPS GAAP vs non-GAAP divergence floor, in dollars/share
  marginDivergencePp: number; // margin GAAP vs non-GAAP divergence floor, in percentage points
  displayLabels: Record<"gaap" | "non_gaap" | "adjusted" | "unadjusted", string>;
}

export const BASIS_CONFIG: BasisConfig = {
  defaultBasis: "gaap",
  derivedBasis: {
    free_cash_flow: { basis: "adjusted", label: "adjusted (company definition)" },
  },
  epsDivergenceUsd: 0.01,
  marginDivergencePp: 0.1,
  displayLabels: { gaap: "GAAP", non_gaap: "non-GAAP", adjusted: "Adjusted", unadjusted: "Unadjusted" },
};

/**
 * P(beat) divergence floor (control P7). The Monte Carlo scenario emits a model-implied probability of
 * beating consensus next quarter; the company's own trailing record emits a historical "beat rate" (the
 * fraction of trailing quarters whose revenue grew YoY). When these diverge by more than `thresholdPts`
 * percentage points we surface ONE sentence — explicitly a momentum PROXY, never a forecast — so a
 * model that implies a near-certain beat against a company that has topped year-ago revenue only rarely
 * (or vice-versa) is flagged rather than presented as settled. Config-not-code: both knobs are tunable.
 *   - thresholdPts: minimum |model P(beat) − trailing beat rate|, in percentage points, to emit the note.
 *   - minHistoryPeriods: minimum trailing YoY-growth observations required to trust the beat rate (below
 *     this the rate is null and NO note is emitted — never fabricate a rate from too few quarters).
 */
export interface PbeatConfig {
  thresholdPts: number;
  minHistoryPeriods: number;
}

export const PBEAT_CONFIG: PbeatConfig = {
  thresholdPts: 30,
  minHistoryPeriods: 4,
};
