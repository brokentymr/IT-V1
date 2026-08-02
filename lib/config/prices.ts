/**
 * Price-anomaly monitor configuration (Phase 6, spec §9.6 salience layer). Config-not-code, tunable
 * without a rebuild. Daily close-to-close moves via the free pull; intraday/indicator depth arrives
 * when the TradingView alert layer is wired.
 */
export interface PricesConfig {
  /** Daily |close-to-close return| at/above this opens a price_action area of interest. */
  anomalyMovePct: number;
  /** Trading days of history to pull (for the move + recent volatility context). */
  lookbackDays: number;
  /** Market benchmark for the idiosyncratic-vs-market split (Yahoo symbol). */
  benchmark: string;
  /** Bands for the area's importance, by |move|. */
  majorMovePct: number;
}

export const PRICES_CONFIG: PricesConfig = {
  anomalyMovePct: 0.04, // 4% daily move
  lookbackDays: 30,
  benchmark: "SPY",
  majorMovePct: 0.07, // ≥7% → "major"
};

/**
 * Price-context / staleness-guard configuration (desk pipeline). Config-not-code: the thresholds that
 * decide when the market has "already repriced" ahead of an unrevised sell-side target — the signal
 * that flips a report from "buy the dislocation" to "the frame is stale, re-underwrite."
 *
 * - repricedGapPct: analyst target must sit at least this fraction ABOVE the verified spot for the gap
 *   to count as a possible stale-target signal (e.g. 0.15 → target ≥15% above price).
 * - nearLowPct: spot must be within this fraction of its own 2-month low for the large target gap to
 *   read as "market has repriced" rather than "ordinary discount to target" (e.g. 0.08 → within 8%).
 * - ret30dRepricePct: a 30-day drawdown at/beyond this magnitude independently marks a repriced frame
 *   (e.g. -0.15 → down ≥15% in a month), even if the target gap is unavailable.
 */
export interface PriceContextConfig {
  repricedGapPct: number;
  nearLowPct: number;
  ret30dRepricePct: number;
}

export const PRICE_CONTEXT_CONFIG: PriceContextConfig = {
  repricedGapPct: 0.15,
  nearLowPct: 0.08,
  ret30dRepricePct: -0.15,
};
