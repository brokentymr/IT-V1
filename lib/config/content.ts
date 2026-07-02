/**
 * Content dedup/fact-registry configuration (control P9). Config-not-code (mirrors lib/config/sentiment.ts):
 * the numeric-repeat lint thresholds and the fact-registry knobs live here so the spider's anti-repetition
 * behaviour is tunable without touching the pure lint/registry logic.
 */
export interface ContentLintConfig {
  /** A normalized numeric token may appear at most this many times across the whole spider before it is flagged. */
  maxNumericRepeats: number;
  /** Skip plain integers that look like calendar years (1900–2099) — they are context, not a repeated stat. */
  ignoreYears: boolean;
  /** Plain integers below this magnitude are too generic to be worth flagging (counts, small ordinals). */
  minInteger: number;
  /** Extra normalized tokens to always ignore (e.g. "0", "1"); compared after normalizeNumeric(). */
  ignoreTokens: string[];
}

export interface FactRegistryConfig {
  /** Up to this many canonical fundamentals numbers are materialized into the registry (assemble.ts slices 6). */
  maxFundamentals: number;
  /** How many recent price signals to surface as canonical facts. */
  maxSignals: number;
}

export const CONTENT_LINT_CONFIG: ContentLintConfig = {
  maxNumericRepeats: 2,
  ignoreYears: true,
  minInteger: 100,
  ignoreTokens: ["0", "1", "2", "3"],
};

export const FACT_REGISTRY_CONFIG: FactRegistryConfig = {
  maxFundamentals: 6,
  maxSignals: 3,
};
