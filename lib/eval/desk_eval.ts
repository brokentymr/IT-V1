/**
 * Desk evaluation harness (pipeline upgrade — docs/UPGRADE-pipeline-rearchitecture.md §7).
 *
 * Turns the Micron critique into measurable scores so we can tell — objectively, not by vibes —
 * whether the upgraded desk is better. Scores a completed snapshot on the four failures the review
 * surfaced: true-data rejection, grounded coverage, decision completeness, and model coherence. Pure —
 * no LLM, no DB — so it is trivially testable and can run over any snapshot content.
 */

export interface EvalContent {
  research?: {
    panel?: Array<{ lens?: string; summary?: string; key_points?: string[]; risks?: string[]; claims?: Array<{ statement?: string; grounded?: boolean }> }>;
    verification?: { verdicts?: Array<{ claim?: string; status?: string; note?: string }>; confidence?: number };
    grounding?: { coverage?: number; supported?: number; total?: number };
  };
  positioning?: {
    strategic_stance?: string;
    variant_view?: string;
    is_consensus?: boolean;
    catalysts?: unknown[];
    price_target?: { bear: number | null; base: number | null; bull: number | null };
  };
  scenario?: { coherence?: { agree?: boolean; note?: string } };
}

/**
 * The single worst failure the review found: the desk rejecting a true, reported figure as an error.
 * We scan the panel and the verdicts for the language of disbelief aimed at reported data. A hit means
 * the desk called real data fake — an automatic F.
 */
// Phrases that call reported data FAKE — kept to the unambiguous ones. Broader phrases like "outside
// any plausible range" or "period aggregation" were removed: a real analyst uses them for durability
// ("84% is outside the plausible range for a SUSTAINED margin"), which is analysis, not data-rejection.
const REJECTION_PHRASES = [
  "physically impossible",
  "statistically implausible",
  "data error",
  "data-extraction error",
  "extraction error",
  "xbrl error",
  "almost certainly a data",
  "data corruption",
  "data integrity",
  "data artifact",
  "tagging error",
  "should not be used as ground truth",
  "not be used as ground truth",
  "contain material errors",
];

// If the same text AFFIRMS the data is real, a rejection phrase in it is being REFUTED, not asserted —
// don't flag it (fixes the false positive on "...are real and are explained by...not a data artifact").
const AFFIRMING_PHRASES = ["are real", "is real", "are genuine", "is genuine", "reflect genuine", "not a data error", "not an artifact", "not a bug", "not a data artifact", "rather than accounting anomaly", "rather than an artifact"];

export function detectTrueDataRejection(c: EvalContent): { rejected: boolean; hits: string[] } {
  const texts: string[] = [];
  for (const p of c.research?.panel ?? []) {
    if (p.summary) texts.push(p.summary);
    for (const k of p.key_points ?? []) texts.push(k);
    for (const cl of p.claims ?? []) if (cl.statement) texts.push(cl.statement);
  }
  for (const v of c.research?.verification?.verdicts ?? []) {
    if (v.claim) texts.push(v.claim);
    if (v.note) texts.push(v.note);
  }
  const hits: string[] = [];
  for (const t of texts) {
    const lower = t.toLowerCase();
    if (REJECTION_PHRASES.some((p) => lower.includes(p)) && !AFFIRMING_PHRASES.some((a) => lower.includes(a))) {
      hits.push(t.slice(0, 140));
    }
  }
  return { rejected: hits.length > 0, hits: [...new Set(hits)].slice(0, 8) };
}

/** Fraction of load-bearing claims backed by evidence. Prefers the stamped grounding report; falls
 *  back to counting supported verdicts. */
export function groundednessScore(c: EvalContent): number {
  const g = c.research?.grounding;
  if (g && typeof g.coverage === "number") return g.coverage;
  const verdicts = c.research?.verification?.verdicts ?? [];
  if (!verdicts.length) return 0;
  return verdicts.filter((v) => v.status === "supported").length / verdicts.length;
}

/** Did the report DECIDE, or only describe? (Doc 2's six-question test, structurally.) */
export function decisionCompleteness(c: EvalContent): {
  hasStance: boolean; hasVariant: boolean; hasCatalysts: boolean; hasTarget: boolean; complete: boolean;
} {
  const p = c.positioning;
  const hasStance = !!p?.strategic_stance;
  const hasVariant = !!p?.variant_view?.trim();
  const hasCatalysts = (p?.catalysts?.length ?? 0) > 0;
  const t = p?.price_target;
  const hasTarget = !!t && (t.bear != null || t.base != null || t.bull != null);
  return { hasStance, hasVariant, hasCatalysts, hasTarget, complete: hasStance && hasVariant && hasCatalysts };
}

/** Model coherence verdict: true = coherent, false = incoherent, null = no scenario to judge. */
export function coherenceState(c: EvalContent): boolean | null {
  const co = c.scenario?.coherence;
  if (!co || typeof co.agree !== "boolean") return null;
  return co.agree;
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export interface Scorecard {
  grade: Grade;
  trueDataRejection: boolean;
  groundedCoverage: number;
  decisionComplete: boolean;
  coherent: boolean | null;
  issues: string[];
}

/**
 * Overall scorecard. True-data rejection is an automatic F — the failure that started the review. Absent
 * that, the grade is driven by grounded coverage, whether the report decided, and model coherence.
 */
export function evaluateSnapshot(c: EvalContent, opts: { minGroundedCoverage?: number } = {}): Scorecard {
  const minCov = opts.minGroundedCoverage ?? 0.5;
  const tdr = detectTrueDataRejection(c);
  const cov = groundednessScore(c);
  const dc = decisionCompleteness(c);
  const coherent = coherenceState(c);

  const issues: string[] = [];
  if (tdr.rejected) issues.push(`true-data rejection: "${tdr.hits[0]}"`);
  if (cov < minCov) issues.push(`grounded coverage ${(cov * 100).toFixed(0)}% < ${(minCov * 100).toFixed(0)}%`);
  if (!dc.complete) {
    const missing = [!dc.hasStance && "stance", !dc.hasVariant && "variant view", !dc.hasCatalysts && "catalysts"].filter(Boolean);
    issues.push(`decision incomplete (missing ${missing.join(", ")})`);
  }
  if (coherent === false) issues.push("model incoherent (drivers vs scenario)");

  let grade: Grade;
  if (tdr.rejected) {
    grade = "F";
  } else {
    const good = (cov >= minCov ? 1 : 0) + (dc.complete ? 1 : 0) + (coherent !== false ? 1 : 0);
    grade = good === 3 ? "A" : good === 2 ? "B" : good === 1 ? "C" : "D";
  }

  return { grade, trueDataRejection: tdr.rejected, groundedCoverage: cov, decisionComplete: dc.complete, coherent, issues };
}
