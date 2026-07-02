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
  /**
   * Statistical floor (control P7). Below `minVolumeForTrend` samples a platform's crowd read is noise:
   * we suppress its trend/net display ("insufficient volume") while keeping the numeric sentiment for
   * back-compat. Between the two floors we cap the displayed net to 1 decimal (the extra precision is
   * spurious at low N); at/above `lowPrecisionVolume` the full 2-decimal net stands. When EVERY
   * contributing platform is below the floor we also scrub velocity/tempo language (`tempoBannedPhrases`)
   * from the narrative so a thin sample can't read as "momentum building".
   */
  minVolumeForTrend: number;
  lowPrecisionVolume: number;
  tempoBannedPhrases: string[];
}

export const SENTIMENT_CONFIG: SentimentConfig = {
  windowDays: 7,
  platforms: ["stocktwits", "gdelt", "news"],
  maxSampleItems: 12,
  confidencePenaltyPerMissing: 0.3,
  gapAoiMagnitudes: ["high", "medium"],
  minVolumeForTrend: 50,
  lowPrecisionVolume: 100,
  tempoBannedPhrases: [
    "accelerating", "accelerates", "accelerated", "acceleration",
    "surging", "surges", "surged", "surge",
    "exploding", "explodes", "exploded", "explosive",
    "skyrocketing", "skyrockets", "skyrocketed",
    "gaining momentum", "momentum building", "building momentum",
    "picking up steam", "gaining steam", "ramping up", "ramping",
    "going parabolic", "parabolic", "melting up", "melt-up", "melt up",
    "piling in", "piling into",
  ],
};
