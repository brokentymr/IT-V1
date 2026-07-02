/**
 * Positioning readout config (control P12). Config-not-code: the illustrative multiple, the
 * fair-value label, and the tolerances used to reconcile the desk's LEAN against the scenario spread
 * live here — never hard-coded in the deterministic readout.
 *
 * - defaultMultiple: the P/E applied to scenario EPS when no consensus multiple is available. The
 *   resulting fair value is explicitly ILLUSTRATIVE (labeled), never a formal price target.
 * - illustrativeLabel: the basis text stamped on every derived fair value.
 * - leanContradictionTolerance: how far base fair value must clear (bullish) or fall under (bearish)
 *   spot before the lean is judged consistent with the spread.
 * - highGrossMarginThreshold: the gross-margin level above which "sustaining spot leans on GM staying
 *   above X%" is surfaced as an implied assumption.
 * - defaultActionRule: the deterministic fallback rule attached to any invalidation trigger the desk
 *   left without an authored action rule (so EVERY trigger gets a rule).
 */
export interface PositioningConfig {
  defaultMultiple: number;
  illustrativeLabel: string;
  leanContradictionTolerance: number;
  highGrossMarginThreshold: number;
  defaultActionRule: string;
}

export const POSITIONING_CONFIG: PositioningConfig = {
  defaultMultiple: 15,
  illustrativeLabel: "illustrative — scenario EPS × multiple, not a formal price target",
  leanContradictionTolerance: 0,
  highGrossMarginThreshold: 0.8,
  defaultActionRule: "If this triggers, cut exposure and re-underwrite the thesis before adding.",
};
