/**
 * News & Events Monitor configuration (spec §4.3, §4.6) — config-not-code, tunable without a
 * rebuild. (A future phase can promote this to a DB table; the shape stays the same.)
 */
export interface MonitorConfig {
  /** Importance-rubric band thresholds (0–100). */
  bands: { flag: number; escalate: number };
  /** Days of sentiment coverage after a major event. */
  escalationWindowDays: number;
  /** Read-through traversal limits. */
  readThrough: { maxDepthHops: number; materialityFloor: number };
  /** News lookback window (days). */
  newsSinceDays: number;
  /** Cap on articles analyzed per company per run (cost control; a Haiku pre-filter scales this later). */
  maxArticlesPerCompany: number;
}

export const MONITOR_CONFIG: MonitorConfig = {
  bands: { flag: 40, escalate: 70 },
  escalationWindowDays: 7,
  readThrough: { maxDepthHops: 2, materialityFloor: 40 },
  newsSinceDays: 2,
  maxArticlesPerCompany: 8,
};

export type Band = "low" | "material" | "major";
export type NoteStatusValue = "logged" | "flagged" | "escalated";

export function bandFor(score: number, cfg: MonitorConfig = MONITOR_CONFIG): Band {
  if (score >= cfg.bands.escalate) return "major";
  if (score >= cfg.bands.flag) return "material";
  return "low";
}

export function statusFor(score: number, cfg: MonitorConfig = MONITOR_CONFIG): NoteStatusValue {
  const b = bandFor(score, cfg);
  return b === "major" ? "escalated" : b === "material" ? "flagged" : "logged";
}

export const materialityRank: Record<"low" | "medium" | "high", number> = { low: 1, medium: 2, high: 3 };
