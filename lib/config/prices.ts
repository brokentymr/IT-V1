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
