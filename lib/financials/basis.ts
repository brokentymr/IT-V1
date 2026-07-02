/**
 * Basis labeling (control P11 — GAAP / non-GAAP / adjusted). Pure and deterministic: no LLM, no DB,
 * no RNG. Every figure the pipeline reports carries a reporting basis so a non-GAAP number can never
 * be silently read as GAAP.
 *
 *   - buildBasisBlock: label every XBRL line item GAAP (they are, by definition) and derive the FCF
 *     bridge (operating cash flow − capex) which we label "adjusted (company definition)".
 *   - reconcileBases: one reconciliation row per EPS / margin pair whose GAAP vs non-GAAP values
 *     diverge beyond the configured tolerance (equal-within-tolerance pairs produce no row).
 *   - scanUnlabeledBasis: a regex guard flagging EPS / margin figures asserted in narrative that
 *     differ from the labeled GAAP model value and carry no basis word — an unlabeled non-GAAP number.
 *
 * Missing inputs degrade to empty/null — never a fabricated figure or label.
 */
import { BASIS_CONFIG } from "../config/fundamentals";
import type { FinancialModel } from "./model";
import type { Levers } from "./levers";
import type { BasisBlock, BasisReconciliationItem, BasisLabel } from "../types";

/** The non-GAAP figures a filing discloses alongside GAAP (from the analyst's reconciliation table). */
export interface NonGaapReconciliation {
  eps: number | null;            // non-GAAP diluted EPS, dollars/share
  gross_margin: number | null;   // non-GAAP margins as FRACTIONS (0..1), aligned with model.ratios
  operating_margin: number | null;
  net_margin: number | null;
  label: string;                 // e.g. "non-GAAP (company adjusted)"
}

const MARGIN_KEYS = ["gross_margin", "operating_margin", "net_margin"] as const;
type MarginKey = (typeof MARGIN_KEYS)[number];

/** Label every line item GAAP and derive the FCF bridge (adjusted, company definition). */
export function buildBasisBlock(model: FinancialModel, levers: Levers): BasisBlock {
  const line_item_basis: Record<string, BasisLabel> = {};
  for (const key of Object.keys(model.line_items)) line_item_basis[key] = BASIS_CONFIG.defaultBasis;

  const ocf = model.line_items.operating_cash_flow?.value ?? null;
  const capex = model.line_items.capex?.value ?? null;
  // FCF is a company-defined (adjusted) figure: operating cash flow − capex. Cross-checks the lever.
  const fcf = ocf != null && capex != null ? ocf - capex : (levers.balance_sheet.free_cash_flow ?? null);
  const fcf_bridge = ocf != null && capex != null ? { ocf, capex, fcf: fcf as number } : null;

  return { line_item_basis, fcf_bridge, reconciliations: [], unlabeled_flags: [], provenance: [] };
}

/** One reconciliation row per EPS / margin pair diverging beyond tolerance (same period, GAAP vs non-GAAP). */
export function reconcileBases(model: FinancialModel, nonGaap: NonGaapReconciliation): BasisReconciliationItem[] {
  const items: BasisReconciliationItem[] = [];
  const label = nonGaap.label || BASIS_CONFIG.displayLabels.non_gaap;

  const gaapEps = model.line_items.eps_diluted?.value;
  if (gaapEps != null && nonGaap.eps != null && Math.abs(gaapEps - nonGaap.eps) > BASIS_CONFIG.epsDivergenceUsd) {
    items.push({
      metric: "eps_diluted", gaap_value: gaapEps, non_gaap_value: nonGaap.eps,
      delta: nonGaap.eps - gaapEps, gaap_label: BASIS_CONFIG.displayLabels.gaap, non_gaap_label: label,
    });
  }

  for (const rk of MARGIN_KEYS) {
    const g = model.ratios[rk];
    const n = nonGaap[rk as MarginKey];
    // Margins are fractions; the tolerance is in percentage points.
    if (g != null && n != null && Math.abs((g - n) * 100) > BASIS_CONFIG.marginDivergencePp) {
      items.push({
        metric: rk, gaap_value: g, non_gaap_value: n,
        delta: n - g, gaap_label: BASIS_CONFIG.displayLabels.gaap, non_gaap_label: label,
      });
    }
  }

  return items;
}

const BASIS_WORD = /(non-?gaap|gaap|adjusted|unadjusted|reported|as reported)/i;

/** A window of `radius` chars around [start,end) — used to check for a basis word near a figure. */
const windowAround = (text: string, start: number, end: number, radius = 45): string =>
  text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));

const approx = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/**
 * Flag EPS / margin figures in narrative that differ from the labeled GAAP model value and carry no
 * basis word. When the figure matches the disclosed non-GAAP value, the flag says so (it needs a label).
 */
export function scanUnlabeledBasis(
  text: string | null | undefined,
  model: FinancialModel,
  nonGaap: NonGaapReconciliation | null,
): string[] {
  if (!text) return [];
  const flags: string[] = [];

  // --- EPS ---
  const gaapEps = model.line_items.eps_diluted?.value ?? null;
  if (gaapEps != null) {
    // "EPS of $2.50", "diluted EPS was 2.50", "earnings per share of $2.50", "$2.50 per share".
    const epsRe = /(?:diluted\s+)?(?:eps|earnings per share)\s*(?:of|was|were|came in at|reached|hit|:)?\s*\$?\s?(\d+(?:\.\d{1,2})?)|\$\s?(\d+(?:\.\d{1,2})?)\s*(?:per (?:diluted )?share|\/\s*share|eps)/gi;
    for (const m of text.matchAll(epsRe)) {
      const raw = m[1] ?? m[2];
      if (raw == null) continue;
      const val = Number(raw);
      if (!Number.isFinite(val)) continue;
      if (approx(val, gaapEps, BASIS_CONFIG.epsDivergenceUsd)) continue; // matches GAAP → fine
      const win = windowAround(text, m.index, m.index + m[0].length);
      if (BASIS_WORD.test(win)) continue; // a basis word is present → labeled
      const nonGaapNote = nonGaap?.eps != null && approx(val, nonGaap.eps, BASIS_CONFIG.epsDivergenceUsd)
        ? " (matches disclosed non-GAAP EPS — needs a basis label)" : "";
      flags.push(`Unlabeled EPS "$${raw}" in narrative differs from GAAP $${gaapEps.toFixed(2)} with no basis stated${nonGaapNote}`);
    }
  }

  // --- Margins (gross / operating / net) ---
  const marginRe = /(gross|operating|net)\s+margin\s*(?:of|was|were|came in at|reached|:)?\s*(\d+(?:\.\d+)?)\s?%|(\d+(?:\.\d+)?)\s?%\s+(gross|operating|net)\s+margin/gi;
  for (const m of text.matchAll(marginRe)) {
    const kind = (m[1] ?? m[4] ?? "").toLowerCase();
    const raw = m[2] ?? m[3];
    if (!kind || raw == null) continue;
    const key = `${kind}_margin` as MarginKey;
    const gaap = model.ratios[key];
    if (gaap == null) continue;
    const pct = Number(raw);
    if (!Number.isFinite(pct)) continue;
    const gaapPct = gaap * 100;
    if (approx(pct, gaapPct, BASIS_CONFIG.marginDivergencePp)) continue; // matches GAAP → fine
    const win = windowAround(text, m.index, m.index + m[0].length);
    if (BASIS_WORD.test(win)) continue;
    const ng = nonGaap?.[key];
    const nonGaapNote = ng != null && approx(pct, ng * 100, BASIS_CONFIG.marginDivergencePp)
      ? " (matches disclosed non-GAAP margin — needs a basis label)" : "";
    flags.push(`Unlabeled ${kind} margin "${raw}%" in narrative differs from GAAP ${gaapPct.toFixed(1)}% with no basis stated${nonGaapNote}`);
  }

  return flags;
}
