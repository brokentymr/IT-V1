/**
 * Deterministic accounting-identity gate (MU-audit control P1 — see docs/UPGRADE-mu-audit-controls.md).
 *
 * LLM extraction will produce wrong financials at some rate forever; the defense is arithmetic, not a
 * better prompt. Before any narrative synthesis reasons over the numbers, this non-LLM validator asserts
 * the identities a real statement must satisfy:
 *   - Assets = Liabilities + Equity (balance sheet ties).
 *   - Every income/cash-flow item covers the SAME reporting period (a 9-month YTD figure read as the
 *     quarter is a period mismatch — the exact Micron defect: 9-month OCF $45.7B vs 3-month revenue).
 *   - Operating cash flow does not exceed revenue for the same period (else it needs a cited exception).
 *
 * A HARD violation means the numbers are not trustworthy: the caller must NOT let the desk narrate an
 * explanation for them (that is how a fabricated "$18B SCA deposits" story gets written), must keep the
 * implicated metrics out of the surprise investigator, and must not auto-publish — route to review.
 * Missing inputs are skipped (degrade, never fabricate a pass).
 */
import type { FinancialModel } from "./model";

export type IdentitySeverity = "hard" | "soft";

export interface IdentityViolation {
  identity: string;
  severity: IdentitySeverity;
  detail: string;
  metrics: string[]; // line-item keys implicated — kept out of the surprise briefing
}

export interface IdentityReport {
  ok: boolean; // no HARD violations
  hard: number;
  soft: number;
  violations: IdentityViolation[];
  checks_run: string[]; // the identities that had enough data to evaluate (the execution log)
}

const b = (n: number): string => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(0)}M`);

const periodDays = (li: { period_start: string | null; period_end: string } | undefined): number | null => {
  if (!li?.period_start || !li?.period_end) return null;
  return (Date.parse(`${li.period_end}T00:00:00Z`) - Date.parse(`${li.period_start}T00:00:00Z`)) / 86_400_000;
};

/** Metrics that must all cover one reporting duration (income statement + cash-flow statement flows). */
const FLOW_KEYS = ["revenue", "net_income", "operating_income", "gross_profit", "cost_of_revenue", "operating_cash_flow", "capex"];

export function checkIdentities(
  model: Pick<FinancialModel, "line_items">,
  opts: { relTolerance?: number; periodToleranceDays?: number } = {},
): IdentityReport {
  const tol = opts.relTolerance ?? 0.02; // 2% — absorbs rounding/minority-interest presentation
  const periodTol = opts.periodToleranceDays ?? 20;
  const li = model.line_items;
  const v = (k: string): number | null => {
    const x = li[k]?.value;
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  };
  const violations: IdentityViolation[] = [];
  const checks: string[] = [];

  // 1. Balance sheet: Assets = Liabilities + Equity.
  const assets = v("total_assets"), liab = v("total_liabilities"), eq = v("stockholders_equity");
  if (assets != null && liab != null && eq != null) {
    checks.push("balance_sheet");
    const off = Math.abs(assets - (liab + eq));
    if (assets !== 0 && off / Math.abs(assets) > tol) {
      violations.push({
        identity: "assets = liabilities + equity",
        severity: "hard",
        detail: `total assets ${b(assets)} ≠ liabilities + equity ${b(liab + eq)} (off ${b(off)})`,
        metrics: ["total_assets", "total_liabilities", "stockholders_equity"],
      });
    }
  }

  // 2. Flow-period consistency: every income/cash-flow item must cover the same reporting duration.
  const durs = FLOW_KEYS.map((k) => ({ k, d: periodDays(li[k]) })).filter((x): x is { k: string; d: number } => x.d != null);
  if (durs.length >= 2) {
    checks.push("flow_period_consistency");
    const anchor = durs.find((x) => x.k === "revenue") ?? durs[0];
    for (const x of durs) {
      if (x.k !== anchor.k && Math.abs(x.d - anchor.d) > periodTol) {
        violations.push({
          identity: "flow metrics share one reporting period",
          severity: "hard",
          // Implicate only the off-period metric (the likely extraction error); the anchor is the
          // reference and must stay eligible for its own (legitimate) surprise investigation.
          detail: `${x.k} spans ${Math.round(x.d)}d but ${anchor.k} spans ${Math.round(anchor.d)}d — period mismatch (a fiscal-YTD figure read as the quarter)`,
          metrics: [x.k],
        });
      }
    }
  }

  // 3. Operating cash flow ≤ revenue for the same period. A genuine OCF>revenue (matching periods) is
  //    rare but possible (large deferred-revenue collections) → soft, needs a cited exception. With a
  //    period mismatch it is an extraction error → hard.
  const ocf = v("operating_cash_flow"), rev = v("revenue");
  if (ocf != null && rev != null) {
    checks.push("ocf_le_revenue");
    if (ocf > rev * (1 + tol)) {
      const ocfD = periodDays(li.operating_cash_flow), revD = periodDays(li.revenue);
      const mismatch = ocfD != null && revD != null && Math.abs(ocfD - revD) > periodTol;
      violations.push({
        identity: "operating cash flow ≤ revenue",
        severity: mismatch ? "hard" : "soft",
        detail: `OCF ${b(ocf)} exceeds revenue ${b(rev)}${mismatch ? " and their periods differ — extraction error" : " for the same period — verify against the filing, requires a cited exception"}`,
        metrics: ["operating_cash_flow"],
      });
    }
  }

  const hard = violations.filter((x) => x.severity === "hard").length;
  return { ok: hard === 0, hard, soft: violations.length - hard, violations, checks_run: checks };
}

/** Compact one-line log of what the gate checked and found — the "gate executed" evidence. */
export function identityLog(r: IdentityReport): string {
  const status = r.ok ? "PASS" : "HARD-FAIL";
  const detail = r.violations.length ? ` [${r.violations.map((x) => `${x.severity}:${x.identity}`).join("; ")}]` : "";
  return `identity gate ${status} — checks: ${r.checks_run.join(", ") || "none"}; hard=${r.hard} soft=${r.soft}${detail}`;
}
