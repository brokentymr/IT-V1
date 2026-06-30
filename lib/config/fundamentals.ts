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
  /** Line items extracted from XBRL company facts. */
  metrics: MetricSpec[];
}

export const FUNDAMENTALS_CONFIG: FundamentalsConfig = {
  triggerForms: ["10-K", "10-Q", "8-K", "S-1"],
  forwardLeadDays: 10,
  linkTextBudget: 24_000,
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
  ],
};
