/**
 * Statistical floor for Engine 4 — Brand/Sentiment (control P7). Pure and DB-free so it unit-tests
 * without a database. A crowd read on a handful of samples is noise dressed as signal; this module
 * enforces a volume floor on the deterministic aggregate BEFORE it is displayed or narrated:
 *   - below `minVolumeForTrend`: the trend and the net-sentiment DISPLAY are suppressed to the sentinel
 *     "insufficient volume" and the row is flagged `low_volume` (the numeric `sentiment` is kept intact
 *     for back-compat / downstream math — we only stop the UI from over-reading it);
 *   - between the two floors: the extra decimal of net is spurious at low N, so the DISPLAY (and the
 *     numeric, for consistency) is rounded to one decimal;
 *   - at/above `lowPrecisionVolume`: the full two-decimal net stands.
 * When EVERY contributing platform is below the floor, the whole window is too thin to claim tempo, so
 * `shouldSuppressTempo` is true and the narrative is scrubbed of velocity language via `scrubTempo`.
 */
import type { SentimentConfig } from "../config/sentiment";

/** The deterministic aggregate for one platform, as built by the engine before display/narration. */
export interface PlatformAggregate {
  platform: string;
  volume: number;
  sentiment: number;
  trend: string;
  top_themes: string[];
}

/** The floored aggregate: numeric sentiment preserved, DISPLAY + trend gated by volume. */
export interface FlooredAggregate extends PlatformAggregate {
  net_display: string;
  low_volume: boolean;
}

const INSUFFICIENT = "insufficient volume";

/**
 * Apply the volume floor to a single platform aggregate. Never fabricates: it can only suppress a
 * too-thin read or trim spurious precision — the numeric sentiment is retained (rounded, not blanked).
 */
export function applyVolumeFloor(agg: PlatformAggregate, cfg: SentimentConfig): FlooredAggregate {
  const { volume } = agg;
  if (volume < cfg.minVolumeForTrend) {
    // Too thin to trust a direction: suppress the trend + net display, keep the numeric for back-compat.
    return { ...agg, trend: INSUFFICIENT, net_display: INSUFFICIENT, low_volume: true };
  }
  if (volume < cfg.lowPrecisionVolume) {
    // Enough to show a direction, not enough for two decimals: cap to one decimal (display + numeric).
    const rounded = Number(agg.sentiment.toFixed(1));
    return { ...agg, sentiment: rounded, net_display: rounded.toFixed(1), low_volume: false };
  }
  // Full-precision regime: two decimals (matches the pre-P7 display, no information lost).
  const rounded2 = Number(agg.sentiment.toFixed(2));
  return { ...agg, sentiment: rounded2, net_display: rounded2.toFixed(2), low_volume: false };
}

/**
 * True only when EVERY contributing platform is below the volume floor — i.e. the entire window is too
 * thin to make any tempo/velocity claim. An empty list is treated as suppressible (no volume anywhere).
 */
export function shouldSuppressTempo(
  platforms: Array<{ volume: number }>,
  cfg: SentimentConfig,
): boolean {
  return platforms.every((p) => p.volume < cfg.minVolumeForTrend);
}

/** Escape a phrase for use inside a RegExp (banned phrases are plain strings, some with punctuation). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Longest phrases first so a multi-word phrase is stripped before its constituent single words.
function bannedPattern(phrases: string[]): RegExp | null {
  const cleaned = phrases.map((p) => p.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!cleaned.length) return null;
  return new RegExp(`\\b(?:${cleaned.map(escapeRe).join("|")})\\b`, "gi");
}

/**
 * Deterministically neutralize banned velocity/tempo phrases in `text`, case-insensitively. Idempotent:
 * re-running on already-scrubbed text is a no-op. Cleans up the wreckage a naive strip leaves behind —
 * doubled spaces, a space before punctuation, and dangling connectors ("is , and") — so the sentence
 * still reads. Never invents words; it only removes overclaiming tempo language.
 */
export function scrubTempo(text: string, cfg: SentimentConfig): string {
  const re = bannedPattern(cfg.tempoBannedPhrases);
  if (!re || !text) return text;
  let out = text.replace(re, "");
  // Collapse the artefacts of removal (order matters; every rule is idempotent).
  out = out.replace(/\(\s*\)/g, "");             // empty parens left behind
  out = out.replace(/\s+([,.;:!?])/g, "$1");     // space before punctuation
  out = out.replace(/([,;:])(\s*[,;:])+/g, "$1"); // stacked/duplicated connectors
  out = out.replace(/[ \t]{2,}/g, " ");          // collapse runs of spaces
  out = out.replace(/[ \t]+\n/g, "\n");          // trailing space before newline
  out = out.replace(/^[\s,;:.!?]+/, "");         // dangling leading punctuation
  return out.trim();
}
