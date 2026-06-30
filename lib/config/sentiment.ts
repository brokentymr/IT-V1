/**
 * Brand/Sentiment engine configuration (Phase 7, spec §4.4). Config-not-code. Keyless platform set
 * for v1 (StockTwits retail, GDELT media-tone, our own news-derived); a missing platform lowers
 * confidence and is flagged, never fails the run.
 */
export interface SentimentConfig {
  /** Coverage window (days) for cadence + the default escalation window. */
  windowDays: number;
  /** Enabled platforms (graceful-degrade if one is unreachable). */
  platforms: Array<"stocktwits" | "gdelt" | "news">;
  /** Max text samples per platform handed to the LLM for theme extraction. */
  maxSampleItems: number;
  /** Confidence (0–1) starts at 1 and drops by this per degraded platform. */
  confidencePenaltyPerMissing: number;
  /** Gap magnitudes that open a sentiment_gap area of interest. */
  gapAoiMagnitudes: Array<"low" | "medium" | "high">;
}

export const SENTIMENT_CONFIG: SentimentConfig = {
  windowDays: 7,
  platforms: ["stocktwits", "gdelt", "news"],
  maxSampleItems: 12,
  confidencePenaltyPerMissing: 0.3,
  gapAoiMagnitudes: ["high", "medium"],
};
