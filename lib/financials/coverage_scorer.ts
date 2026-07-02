/**
 * Per-filing-type disclosure coverage scorer (control P5 — see docs/UPGRADE-mu-audit-controls.md).
 *
 * Pure, deterministic, non-LLM — like the accounting-identity gate (lib/financials/identity.ts), it owns
 * its own report type rather than adding to lib/types.ts. It walks DISCLOSURE_CHECKLIST against the
 * deterministic model, the demand profile, the desk's analysis claim texts, and a bounded excerpt of the
 * filing, and reports which expected disclosures are covered and which are gaps. A CRITICAL gap (no revenue
 * at all, or an RPO/backlog figure disclosed in the filing but never captured) makes ok=false, holding the
 * thesis for human review; expected/optional gaps are stamped for the report but never block. Forward-looking
 * percentage-of-revenue claims with no grounding are soft-flagged. Missing inputs degrade (conditional items
 * are skipped when there is no filing text / demand), never throw, never fabricate a pass.
 */
import { keywordExcerpts as _keywordExcerpts } from "./filing_text";
import {
  DISCLOSURE_CHECKLIST,
  HOLD_SEVERITIES,
  PERCENTAGE_CLAIM,
  DISCLOSURE_TEXT_BUDGET,
  type ChecklistItem,
  type ChecklistSeverity,
} from "../config/disclosure_checklist";

/** The minimal model shape the scorer reads (structural — decoupled from FinancialModel). */
export interface ScorerModel {
  line_items: Record<string, { value: number } | undefined>;
  ratios: Record<string, number | undefined>;
}

/** The minimal driver shape the scorer reads (structural — decoupled from the Driver zod type). */
export interface ScorerDriver {
  framing?: string;
  quote?: string | null;
}

export interface CoverageInput {
  formType: string | null;
  model: ScorerModel;
  demand: Record<string, unknown> | null;
  drivers: ScorerDriver[];
  claimTexts: string[];       // one_liner/long_form/actual_vs_expected + panel claims + driver framing/quote
  filingText: string | null;  // bounded keyword excerpt of the filing (null when no filing document)
}

export interface Gap {
  key: string;
  label: string;
  severity: ChecklistSeverity;
  detail: string;
  disclosed_but_missing?: boolean; // an if_disclosed item the filing disclosed but the analysis missed
}

export interface PctFlag {
  claim: string;
  detail: string;
}

export interface CoverageScorecard {
  form_type: string;
  ok: boolean;                    // no gap whose severity is in HOLD_SEVERITIES
  score: number;                  // covered / applicable (1 when nothing applicable)
  covered: string[];              // checklist keys satisfied
  gaps: Gap[];
  percentage_flags: PctFlag[];
  checks_run: string[];           // checklist keys that had enough data to evaluate (the execution log)
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Form-glob match: "*" matches any form; otherwise a case-insensitive glob ("10-*" etc). */
function appliesTo(item: ChecklistItem, formType: string): boolean {
  const form = formType.toUpperCase().trim();
  return item.applies_to.some((glob) => {
    if (glob === "*") return true;
    const re = new RegExp(`^${glob.toUpperCase().replace(/[.]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return re.test(form);
  });
}

/** Fresh, flag-safe regex from a stored pattern source. */
const rx = (pattern: string, flags = "i"): RegExp => new RegExp(pattern, flags);

/** Non-conditional presence: line item / ratio / computed FCF / demand field. */
function detectPresent(item: ChecklistItem, model: ScorerModel, demand: Record<string, unknown> | null, claims: string): boolean {
  const d = item.detect;
  switch (d.kind) {
    case "line_item":
      return !!d.key && finite(model.line_items[d.key]?.value);
    case "ratio":
      return !!d.key && finite(model.ratios[d.key]);
    case "computed_fcf":
      return finite(model.line_items.operating_cash_flow?.value) && finite(model.line_items.capex?.value);
    case "demand_field": {
      const field = d.key ? demand?.[d.key] : undefined;
      const hasDemand = typeof field === "string" ? field.trim().length > 0 : field != null && field !== "";
      if (hasDemand) return true;
      return !!d.pattern && rx(d.pattern).test(claims);
    }
    case "text_regex":
      return !!d.pattern && rx(d.pattern).test(claims);
    default:
      return false;
  }
}

/** For an if_disclosed item that WAS disclosed: did the analysis capture it (claims or demand)? */
function capturedInAnalysis(item: ChecklistItem, claims: string, demandText: string): boolean {
  const pattern = item.detect.pattern;
  if (!pattern) return false;
  const re = rx(pattern);
  return re.test(claims) || re.test(demandText);
}

/** Scan the analysis for ungrounded forward "X% of revenue/sales/bookings" claims. */
function scanPercentageClaims(claimTexts: string[], drivers: ScorerDriver[], filingText: string | null): PctFlag[] {
  const flags: PctFlag[] = [];
  const driverText = drivers.map((d) => `${d.framing ?? ""} ${d.quote ?? ""}`).join("\n").toLowerCase();
  const filingLower = filingText?.toLowerCase() ?? "";
  for (const text of claimTexts) {
    if (!text) continue;
    const re = rx(PERCENTAGE_CLAIM.pattern.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const claim = m[0].trim();
      const lc = claim.toLowerCase();
      const window = text.slice(Math.max(0, m.index - PERCENTAGE_CLAIM.tagWindow), m.index + claim.length + PERCENTAGE_CLAIM.tagWindow);
      const grounded =
        PERCENTAGE_CLAIM.estimateTag.test(window) ||
        (driverText.length > 0 && driverText.includes(lc)) ||
        (filingLower.length > 0 && filingLower.includes(lc));
      if (!grounded) {
        flags.push({ claim, detail: "forward %-of-revenue claim with no driver quote, filing-text match, or (estimate) tag" });
      }
    }
  }
  return flags;
}

const gapDetail = (item: ChecklistItem): string => {
  switch (item.detect.kind) {
    case "line_item":
      return `${item.label} line item absent from the extracted model`;
    case "ratio":
      return `${item.label} not computable from the extracted model`;
    case "computed_fcf":
      return `free cash flow not computable (operating cash flow and/or capex missing)`;
    case "demand_field":
      return `${item.label} neither in the demand profile nor asserted in the analysis`;
    default:
      return `${item.label} not covered`;
  }
};

export function scoreDisclosureCoverage(input: CoverageInput): CoverageScorecard {
  const formType = (input.formType ?? "Filing").trim() || "Filing";
  const claims = input.claimTexts.filter(Boolean).join("\n");
  const demand = input.demand ?? null;
  const demandText = demand ? JSON.stringify(demand) : "";
  const filingText = input.filingText;

  const covered: string[] = [];
  const gaps: Gap[] = [];
  const checks_run: string[] = [];

  for (const item of DISCLOSURE_CHECKLIST) {
    if (!appliesTo(item, formType)) continue;

    if (item.conditional === "if_disclosed") {
      // Can't tell whether it was disclosed without the filing text → skip (never a false gap).
      if (filingText == null) continue;
      const disclosed = item.disclosureSignal ? item.disclosureSignal.test(filingText) : false;
      checks_run.push(item.key);
      if (!disclosed) continue; // nothing disclosed → nothing to cover
      if (capturedInAnalysis(item, claims, demandText)) {
        covered.push(item.key);
      } else {
        gaps.push({
          key: item.key, label: item.label, severity: item.severity,
          detail: `${item.label} disclosed in the filing but absent from the analysis`,
          disclosed_but_missing: true,
        });
      }
      continue;
    }

    // demand_field items need a demand profile to fully evaluate; skip when there is no demand AND no
    // filing/claim capture path is possible (degrade, don't fabricate a gap on missing inputs).
    checks_run.push(item.key);
    if (detectPresent(item, input.model, demand, claims)) {
      covered.push(item.key);
    } else {
      gaps.push({ key: item.key, label: item.label, severity: item.severity, detail: gapDetail(item) });
    }
  }

  const percentage_flags = scanPercentageClaims(input.claimTexts, input.drivers, filingText);
  const applicable = covered.length + gaps.length;
  const score = applicable ? covered.length / applicable : 1;
  const ok = !gaps.some((g) => HOLD_SEVERITIES.includes(g.severity));

  return { form_type: formType, ok, score, covered, gaps, percentage_flags, checks_run };
}

/** Compact one-line log mirroring identityLog — the "scorer executed" evidence. */
export function coverageScorecardLog(r: CoverageScorecard): string {
  const status = r.ok ? "PASS" : "GAP-HOLD";
  const applicable = r.covered.length + r.gaps.length;
  const gapStr = r.gaps.length ? ` [${r.gaps.map((g) => `${g.severity}:${g.key}${g.disclosed_but_missing ? "*" : ""}`).join("; ")}]` : "";
  const pctStr = r.percentage_flags.length ? ` pct_flags=${r.percentage_flags.length}` : "";
  return `coverage scorer ${status} — ${r.form_type}; covered ${r.covered.length}/${applicable} (${(r.score * 100).toFixed(0)}%); checks: ${r.checks_run.join(", ") || "none"}${gapStr}${pctStr}`;
}

/** Bounded filing excerpt for if_disclosed detection — thin wrapper applying the config char budget. */
export function keywordExcerpts(html: string, keywords: string[], budget: number = DISCLOSURE_TEXT_BUDGET): string {
  return _keywordExcerpts(html, keywords, budget);
}
