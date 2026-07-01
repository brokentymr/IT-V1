/**
 * Grounding discipline (pipeline upgrade — docs/UPGRADE-pipeline-rearchitecture.md §2).
 *
 * "No material claim without a citation." The Micron desk asserted market share, HBM customers, China
 * exposure, and historical margins entirely from the model's own recall — only 2 of 13 claims were
 * backed by the provided evidence — yet still reported a confident view. A thesis carried mostly by
 * ungrounded priors must NOT auto-publish, however fluent it sounds. This module measures grounded
 * coverage and enforces that gate. Pure — no LLM, no DB.
 */

export type VerdictStatus = "supported" | "unverified" | "contradicted";

export interface VerdictLike {
  verdicts: Array<{ status: VerdictStatus }>;
  recommendation: "auto" | "review";
  confidence: number;
}

export interface ClaimLike {
  grounded?: boolean;
  confidence: number;
}

export interface GroundingReport {
  total: number;
  supported: number;
  unverified: number;
  contradicted: number;
  /** supported / total, in [0,1]. 0 when there are no verdicts to stand on. */
  coverage: number;
}

/** Grounded coverage of the load-bearing claims: how many the evidence actually backs. */
export function groundedCoverage(v: VerdictLike): GroundingReport {
  const total = v.verdicts.length;
  const supported = v.verdicts.filter((x) => x.status === "supported").length;
  const unverified = v.verdicts.filter((x) => x.status === "unverified").length;
  const contradicted = v.verdicts.filter((x) => x.status === "contradicted").length;
  return { total, supported, unverified, contradicted, coverage: total ? supported / total : 0 };
}

export interface GroundingGate {
  recommendation: "auto" | "review";
  gated: boolean; // true when we downgraded auto → review purely on grounding
  reason: string | null;
  report: GroundingReport;
}

/**
 * Enforce the grounding gate on a verification result. An auto recommendation survives ONLY if the
 * load-bearing claims clear a minimum grounded-coverage bar and nothing is contradicted. Otherwise it
 * is downgraded to "review" — a confident-but-ungrounded thesis rests at the human checkpoint, never
 * auto-published. Never upgrades review → auto.
 */
export function applyGroundingGate(v: VerdictLike, minCoverage: number): GroundingGate {
  const report = groundedCoverage(v);
  if (v.recommendation !== "auto") {
    return { recommendation: "review", gated: false, reason: null, report };
  }
  if (report.contradicted > 0) {
    return { recommendation: "review", gated: true, reason: `${report.contradicted} contradicted claim(s)`, report };
  }
  if (report.total > 0 && report.coverage < minCoverage) {
    return {
      recommendation: "review",
      gated: true,
      reason: `grounded coverage ${(report.coverage * 100).toFixed(0)}% < ${(minCoverage * 100).toFixed(0)}% bar (${report.supported}/${report.total} claims backed by evidence)`,
      report,
    };
  }
  return { recommendation: "auto", gated: false, reason: null, report };
}

/** Split a lens's claims into the grounded ones (backed by evidence → the confident body) and the
 *  analyst priors (the model's background knowledge → quarantined, to be verified, never inflating
 *  confidence). A claim with no explicit flag is treated as an ungrounded prior (fail-closed). */
export function partitionClaims<T extends ClaimLike>(claims: T[]): { grounded: T[]; priors: T[] } {
  return {
    grounded: claims.filter((c) => c.grounded === true),
    priors: claims.filter((c) => c.grounded !== true),
  };
}
