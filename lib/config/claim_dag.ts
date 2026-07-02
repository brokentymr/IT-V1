/**
 * Config for the claim dependency DAG + stale propagation (control P4). Config-not-code: every
 * threshold that governs restatement detection and edge resolution lives here.
 */
export interface ClaimDagConfig {
  /** A prior fact is treated as RESTATED only if the same fact_key + same period diverges by more than
   *  this relative fraction (or vanished). A routine next-period filing (a different period) never fires. */
  restatementRelThreshold: number;
  /** Keyword tokens shorter than this are ignored when matching a claim's text to a fact. */
  minKeywordLen: number;
  /** When a claim keyword-matches ZERO facts, link it to ALL numeric facts (a broad dependency) so a
   *  correction still propagates rather than silently leaving the claim un-audited. */
  broadFallback: boolean;
  /** On a hard accounting-identity failure (integrity.ok === false), retract the implicated facts and
   *  stale every claim that consumes them. */
  retractOnIdentityHardFail: boolean;
}

export const CLAIM_DAG_CONFIG: ClaimDagConfig = {
  restatementRelThreshold: 0.10,
  minKeywordLen: 5,
  broadFallback: true,
  retractOnIdentityHardFail: true,
};
