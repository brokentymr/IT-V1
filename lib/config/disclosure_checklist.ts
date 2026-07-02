/**
 * Per-filing-type disclosure checklist (control P5 — see docs/UPGRADE-mu-audit-controls.md).
 *
 * A filing is only "covered" once the disclosures a reader of that form expects are (a) present in the
 * deterministic model and (b) captured in the desk's analysis. The scorer (lib/financials/coverage_scorer.ts)
 * walks this checklist against the model + demand profile + the analysis claim texts + a bounded excerpt of
 * the filing, and flags the gaps. Config-not-code: thresholds/severities/keywords live here, never in the
 * scorer. A CRITICAL gap (no revenue at all, or an RPO/backlog figure disclosed in the filing but never
 * captured — the F4 hold) holds the thesis for human review; expected/optional gaps are stamped for the report.
 */

export type ChecklistSeverity = "critical" | "expected" | "optional";

export interface ChecklistDetect {
  /**
   * How the item is detected as covered:
   *  - line_item     — a model line item is present (detect.key)
   *  - ratio         — a model ratio is present (detect.key)
   *  - computed_fcf  — free cash flow is computable (operating_cash_flow AND capex both present)
   *  - text_regex    — detect.pattern is found in the analysis claim texts (used by if_disclosed items)
   *  - demand_field  — a non-empty field on the demand profile (detect.key), OR detect.pattern matched in claims
   */
  kind: "line_item" | "ratio" | "computed_fcf" | "text_regex" | "demand_field";
  key?: string;     // model line_item / ratio / demand field name
  pattern?: string; // regex source used to look for the capture in the analysis
}

export interface ChecklistItem {
  key: string;
  label: string;
  severity: ChecklistSeverity;
  applies_to: string[];        // form globs, e.g. ["10-K","10-Q"] or ["*"]
  detect: ChecklistDetect;
  /** if_disclosed: only expected when disclosureSignal fires over the filing text (else nothing to cover). */
  conditional?: "if_disclosed";
  /** Fires over the filing excerpt to decide the item was disclosed at all. NO global flag (repeated .test()). */
  disclosureSignal?: RegExp;
}

export const DISCLOSURE_CHECKLIST: ChecklistItem[] = [
  {
    key: "revenue",
    label: "Revenue",
    severity: "critical",
    applies_to: ["10-K", "10-Q", "8-K", "*"],
    detect: { kind: "line_item", key: "revenue" },
  },
  {
    key: "gm_gaap",
    label: "Gross margin (GAAP)",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    detect: { kind: "ratio", key: "gross_margin" },
  },
  {
    key: "gm_nongaap",
    label: "Gross margin (non-GAAP)",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    conditional: "if_disclosed",
    disclosureSignal: /non-GAAP|adjusted gross/i,
    detect: { kind: "text_regex", pattern: "non-GAAP|adjusted gross" },
  },
  {
    key: "eps_gaap",
    label: "Diluted EPS (GAAP)",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    detect: { kind: "line_item", key: "eps_diluted" },
  },
  {
    key: "eps_nongaap",
    label: "Diluted EPS (non-GAAP)",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    conditional: "if_disclosed",
    disclosureSignal: /non-GAAP|adjusted (?:diluted )?EPS/i,
    detect: { kind: "text_regex", pattern: "non-GAAP|adjusted (?:diluted )?EPS" },
  },
  {
    key: "ocf",
    label: "Operating cash flow",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    detect: { kind: "line_item", key: "operating_cash_flow" },
  },
  {
    key: "capex",
    label: "Capital expenditure",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    detect: { kind: "line_item", key: "capex" },
  },
  {
    key: "fcf",
    label: "Free cash flow",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    detect: { kind: "computed_fcf" },
  },
  {
    key: "guidance",
    label: "Guidance / outlook",
    severity: "expected",
    applies_to: ["10-K", "10-Q", "8-K"],
    conditional: "if_disclosed",
    disclosureSignal: /guidance|outlook|we expect|for the (?:next|fourth|first) quarter/i,
    detect: { kind: "text_regex", pattern: "guidance|outlook|we expect|for the (?:next|fourth|first) quarter" },
  },
  {
    // The F4 hold: an RPO/backlog dollar figure disclosed in the filing but never captured in the
    // analysis is a CRITICAL coverage gap (it is often the single most important forward signal).
    key: "rpo_backlog",
    label: "Remaining performance obligation / backlog",
    severity: "critical",
    applies_to: ["10-K", "10-Q", "8-K"],
    conditional: "if_disclosed",
    // Only fires when an RPO/backlog term sits near a currency/scale figure (avoids boilerplate matches).
    disclosureSignal: /(?:remaining performance obligation|\bRPO\b|\bbacklog\b)[\s\S]{0,120}(?:\$|billion|million)/i,
    detect: { kind: "text_regex", pattern: "remaining performance obligation|\\bRPO\\b|\\bbacklog\\b" },
  },
  {
    key: "buyback_dividend",
    label: "Buyback / dividend",
    severity: "expected",
    applies_to: ["10-K", "10-Q", "8-K"],
    conditional: "if_disclosed",
    disclosureSignal: /repurchase|buyback|dividend/i,
    detect: { kind: "text_regex", pattern: "repurchase|buyback|dividend" },
  },
  {
    key: "customer_concentration",
    label: "Customer concentration",
    severity: "expected",
    applies_to: ["10-K", "10-Q"],
    detect: { kind: "demand_field", key: "customer_concentration", pattern: "accounted for .* of (?:net )?revenue" },
  },
];

/**
 * Keywords used to build the bounded filing excerpt the scorer reads for if_disclosed detection.
 * keywordExcerpts skips keywords shorter than 4 chars, so short acronyms (RPO) are covered by their
 * spelled-out siblings ("remaining performance obligation" / "backlog").
 */
export const DISCLOSURE_KEYWORDS: string[] = [
  "non-GAAP",
  "adjusted",
  "gross margin",
  "diluted EPS",
  "guidance",
  "outlook",
  "we expect",
  "remaining performance obligation",
  "backlog",
  "repurchase",
  "buyback",
  "dividend",
  "accounted for",
];

/** Severities that HOLD auto-publish when gapped. Only a missing critical disclosure blocks. */
export const HOLD_SEVERITIES: ChecklistSeverity[] = ["critical"];

/** Bounded character budget for the filing excerpt fed to the scorer. */
export const DISCLOSURE_TEXT_BUDGET = 12_000;

/**
 * Percentage-of-revenue claim guard. A forward-looking "~X% of revenue/sales/bookings" assertion in the
 * analysis must be grounded — appear in a driver quote, match the filing text, or carry an "(estimate)"
 * tag — otherwise it is soft-flagged (never blocks; a signal that the desk asserted a forward mix figure
 * without support).
 */
export const PERCENTAGE_CLAIM = {
  // NOTE: compiled fresh with /gi in the scorer; kept flag-free here so .source is reusable.
  pattern: /~?\d{1,3}%\s+of\s+(?:future|forward|next)?\s*(?:revenue|sales|bookings)/i,
  estimateTag: /\(estimate\)/i,
  /** Window (chars) around a match to look for an "(estimate)" tag. */
  tagWindow: 40,
};
