/**
 * Numeric provenance (control P3) — PURE (no DB, no RNG).
 *
 * Two jobs:
 *   1. extractNumbers(text): tokenize free text into typed numeric tokens (currency / percent / ratio /
 *      plain), normalizing magnitude suffixes ($18B → 18e9, $41.5 billion → 41.5e9, $5,700M → 5.7e9,
 *      84.6% → percent). Years (2026), SEC form types (10-Q/10-K/8-K) and conviction ratios (5/5) are
 *      NOT numeric facts and are excluded.
 *   2. buildVerifiedClaims(model, scenario, levers): every figure the pipeline computed from XBRL is a
 *      LOCATED, verified claim (confidence 1.0). quarantineText then holds any free-text invalidation
 *      trigger whose currency figure is implausible vs the model scale. Invalidation triggers are
 *      FORWARD thresholds, not current values, so a threshold that equals no computed figure is still a
 *      legitimate, measurable bar — it is quarantined only when its magnitude is out of scale (or there
 *      is no currency claim to anchor scale at all), which is the fingerprint of a fabricated figure.
 */
import type { FinancialModel } from "../financials/model";
import type { ScenarioOutput } from "../financials/montecarlo";
import type { Levers } from "../financials/levers";
import type { ProvenanceConfig } from "../config/provenance";

export type NumericKind = "currency" | "percent" | "ratio" | "plain";

export interface NumericToken {
  value: number;
  unit: string | null;
  kind: NumericKind;
  raw: string;
}

const NUMWORD = String.raw`\d[\d,]*(?:\.\d+)?`;
// Magnitude suffix: single letters (case-insensitive via the /i flag) or spelled-out words.
const MAG = String.raw`(?:\s*(?:billion|million|thousand|trillion|bn|mm|[bmkt]))`;

// One master scanner, alternatives in PRIORITY order (JS alternation takes the first that matches at a
// position). Form types and conviction fractions are matched FIRST so their digits are consumed and
// never mis-read as plain numbers.
const TOKEN = new RegExp(
  [
    String.raw`(?<form>\b\d{1,2}-[A-Za-z]\b)`, // 10-Q, 10-K, 8-K
    String.raw`(?<frac>\b\d+\s*\/\s*\d+\b)`, // 5/5 conviction ratio
    String.raw`(?<cur>\$\s?${NUMWORD}${MAG}?)`, // $18B, $41.5 billion, $5,700M, $5
    String.raw`(?<pct>${NUMWORD}\s*%)`, // 84.6%, 10%
    String.raw`(?<ratio>\b${NUMWORD}x\b)`, // 2.5x
    String.raw`(?<magnum>\b${NUMWORD}${MAG}\b)`, // 18B without a currency sign
    String.raw`(?<plain>\b${NUMWORD}\b)`, // bare number (years filtered below)
  ].join("|"),
  "gi",
);

const num = (s: string): number => Number(s.replace(/,/g, ""));

/** Multiplier for a trailing magnitude suffix (case-insensitive), or 1 when absent. */
function magnitude(raw: string): number {
  const m = /(billion|million|thousand|trillion|bn|mm|[bmkt])\s*$/i.exec(raw.trim());
  if (!m) return 1;
  const s = m[1].toLowerCase();
  if (s === "b" || s === "bn" || s === "billion") return 1e9;
  if (s === "m" || s === "mm" || s === "million") return 1e6;
  if (s === "k" || s === "thousand") return 1e3;
  if (s === "t" || s === "trillion") return 1e12;
  return 1;
}

/** The leading numeric literal within a raw match (strips $, %, x, suffix words). */
function leadNumber(raw: string): number {
  const m = new RegExp(NUMWORD).exec(raw);
  return m ? num(m[0]) : NaN;
}

export function extractNumbers(text: string): NumericToken[] {
  if (!text) return [];
  const out: NumericToken[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text)) !== null) {
    const g = m.groups ?? {};
    if (g.form != null || g.frac != null) continue; // excluded: form types, conviction ratios
    const raw = m[0];
    if (g.cur != null) {
      out.push({ value: leadNumber(raw) * magnitude(raw), unit: "USD", kind: "currency", raw });
    } else if (g.pct != null) {
      out.push({ value: leadNumber(raw), unit: "%", kind: "percent", raw });
    } else if (g.ratio != null) {
      out.push({ value: leadNumber(raw), unit: "x", kind: "ratio", raw });
    } else if (g.magnum != null) {
      out.push({ value: leadNumber(raw) * magnitude(raw), unit: null, kind: "plain", raw });
    } else if (g.plain != null) {
      const v = leadNumber(raw);
      // A bare 4-digit integer in the calendar range is a year, not a fact.
      if (Number.isInteger(v) && v >= 1900 && v <= 2099 && !/[.,]/.test(raw)) continue;
      out.push({ value: v, unit: null, kind: "plain", raw });
    }
  }
  return out;
}

export interface VerifiedClaim {
  value: number;
  unit: string | null;
  source_locator: string;
  verified: true;
}

/** Every figure the pipeline computed from the filing is a located, verified claim (confidence 1.0). */
export function buildVerifiedClaims(
  model: FinancialModel | null,
  scenario: ScenarioOutput | null,
  levers: Levers | null,
): VerifiedClaim[] {
  const out: VerifiedClaim[] = [];
  const push = (value: number | null | undefined, unit: string | null, source_locator: string) => {
    if (typeof value === "number" && Number.isFinite(value)) out.push({ value, unit, source_locator, verified: true });
  };

  // Line items (dollar / per-share figures) — one located claim each.
  if (model) {
    for (const [k, li] of Object.entries(model.line_items)) push(li.value, li.unit, `xbrl:${k}`);
    // Derived margin ratios (fractions).
    for (const [k, v] of Object.entries(model.ratios)) push(v, null, `xbrl:${k}`);
  }

  // Monte Carlo bands — every percentile of every band is a located figure.
  if (scenario?.bands) {
    for (const [band, b] of Object.entries(scenario.bands)) {
      if (!b) continue;
      const unit = band === "revenue_growth" || band === "net_margin" ? null : "USD";
      push(b.p10, unit, `scenario:${band}`);
      push(b.p50, unit, `scenario:${band}`);
      push(b.p90, unit, `scenario:${band}`);
    }
  }

  // Financial levers (computed from XBRL — ground truth).
  if (levers) {
    push(levers.roe.roe, null, "levers:roe");
    push(levers.roe.net_margin, null, "levers:net_margin");
    push(levers.roe.asset_turnover, null, "levers:asset_turnover");
    push(levers.roe.equity_multiplier, null, "levers:equity_multiplier");
    push(levers.balance_sheet.free_cash_flow, "USD", "levers:free_cash_flow");
    push(levers.balance_sheet.net_cash, "USD", "levers:net_cash");
    push(levers.balance_sheet.current_ratio, null, "levers:current_ratio");
    push(levers.balance_sheet.debt_to_equity, null, "levers:debt_to_equity");
    push(levers.balance_sheet.interest_coverage, null, "levers:interest_coverage");
    push(levers.balance_sheet.cash_conversion, null, "levers:cash_conversion");
    push(levers.balance_sheet.fcf_margin, null, "levers:fcf_margin");
    push(levers.working_capital.dso, "days", "levers:dso");
    push(levers.working_capital.dio, "days", "levers:dio");
    push(levers.working_capital.dpo, "days", "levers:dpo");
    push(levers.working_capital.ccc, "days", "levers:ccc");
  }

  return out;
}

/** Does a token value match any verified claim within the relative tolerance? */
function matchesVerified(value: number, verified: VerifiedClaim[], tol: number): boolean {
  return verified.some((v) => {
    const scale = Math.max(Math.abs(v.value), Math.abs(value));
    if (scale === 0) return true;
    return Math.abs(v.value - value) <= tol * scale;
  });
}

/** Largest absolute currency (USD) figure among the verified claims — the model's own scale (0 if none). */
function maxCurrencyMagnitude(verified: VerifiedClaim[]): number {
  let max = 0;
  for (const v of verified) if (v.unit === "USD") max = Math.max(max, Math.abs(v.value));
  return max;
}

/**
 * Split invalidation triggers into admitted vs quarantined. Invalidation triggers are FORWARD
 * thresholds, not current values — a legitimate, desk-authored bar (e.g. "Revenue falls to $50B" when
 * current revenue is $85.8B) equals no computed figure, so we do NOT require a numeric match. A barred
 * token (default kind: currency) is QUARANTINED only when it is implausible vs the model scale: it
 * neither restates a verified claim (within tolerance) NOR stays within `maxScaleMultiple` of the
 * model's own largest currency figure. If there is no currency claim to anchor scale, a barred currency
 * token cannot be vouched for and is held out. Percent/ratio thresholds and number-free triggers admit.
 */
export function quarantineText(
  triggers: string[],
  verified: VerifiedClaim[],
  cfg: ProvenanceConfig,
): { admitted: string[]; quarantined: string[] } {
  const admitted: string[] = [];
  const quarantined: string[] = [];
  const barred = new Set(cfg.barredKinds);
  const ceiling = maxCurrencyMagnitude(verified) * cfg.maxScaleMultiple;
  for (const t of triggers) {
    const barredTokens = extractNumbers(t).filter((tok) => barred.has(tok.kind));
    const ungrounded = barredTokens.some((tok) => {
      if (matchesVerified(tok.value, verified, cfg.matchToleranceRel)) return false; // restates a computed figure
      if (ceiling === 0) return true; // no currency claim to anchor scale — cannot vouch, hold out
      return Math.abs(tok.value) > ceiling; // out of scale vs the model → fabricated, not a forward bar
    });
    if (ungrounded) quarantined.push(t);
    else admitted.push(t);
  }
  return { admitted, quarantined };
}
