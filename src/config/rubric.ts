// Importance rubric + read-through gating (sections 4.3, 4.6).
//
// The spec is explicit: "The rubric thresholds are configuration, not code, so
// they can be tuned without a rebuild." The raw 0-100 score is what gets
// stored on a news_note; the BAND and the resulting ACTION are derived here.

export type ImportanceBand = 'low' | 'material' | 'major';

export interface RubricConfig {
  /** Lower bound (inclusive) of the "material" band — flag for human review. */
  flagThreshold: number;
  /** Lower bound (inclusive) of the "major" band — escalate a sentiment run. */
  escalationThreshold: number;
  /** Default sentiment-run window after a major event (days); tune by magnitude. */
  defaultEscalationWindowDays: number;
}

export interface ReadThroughConfig {
  /** Max hops a material event travels across company_links (4.6). */
  maxHops: number;
  /** A read-through note is only written at/above this score at each hop. */
  materialityFloor: number;
}

// Defaults from the rubric table in 4.3. Override per-environment.
export const RUBRIC: RubricConfig = {
  flagThreshold: 40, // Material band: 40-69
  escalationThreshold: 70, // Major band: 70-100
  defaultEscalationWindowDays: 7,
};

export const READ_THROUGH: ReadThroughConfig = {
  maxHops: 2,
  materialityFloor: 40, // same flag band gates each hop (4.6 materiality gating)
};

/** Derive the band from a raw 0-100 score using the active config. */
export function bandFor(score: number, cfg: RubricConfig = RUBRIC): ImportanceBand {
  if (score >= cfg.escalationThreshold) return 'major';
  if (score >= cfg.flagThreshold) return 'material';
  return 'low';
}

/** The note status implied by a score: logged | flagged | escalated (4.3). */
export function statusFor(score: number, cfg: RubricConfig = RUBRIC): 'logged' | 'flagged' | 'escalated' {
  const band = bandFor(score, cfg);
  if (band === 'major') return 'escalated';
  if (band === 'material') return 'flagged';
  return 'logged';
}

/** Whether an event at this score should travel a read-through hop (4.6). */
export function travelsReadThrough(score: number, cfg: ReadThroughConfig = READ_THROUGH): boolean {
  return score >= cfg.materialityFloor;
}
