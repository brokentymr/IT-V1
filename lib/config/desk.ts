/**
 * Analyst-desk deepening policy (Workstream C) — config-not-code, like lib/config/fundamentals.ts.
 * The desk auto-escalates scrutiny when adversarial verification is short of the bar, then the
 * auto-commit layer publishes ONLY what clears a deterministic gate computed here (never the
 * model's self-reported "recommendation"). Tunable without a rebuild.
 */
export type DeepeningLever = "enrich" | "relens" | "bump_tier";

export interface DeskConfig {
  /** Clear threshold: verification.confidence must reach this to auto-publish. */
  confidenceBar: number;
  /** HARD block — more than this many `contradicted` verdicts never auto-clears, at any confidence. */
  maxContradicted: number;
  /** Deepening rounds attempted after the round-0 baseline. */
  maxRounds: number;
  /** Which lever each deepening round applies, in order. */
  ladder: DeepeningLever[];
  /** Per-lever kill switches. */
  levers: Record<DeepeningLever, boolean>;
  /** Lens model tier per escalation step; `bump_tier` climbs this ladder (clamped). */
  lensTierLadder: string[];
  /** Synthesis / verification models (fixed strong tier; not laddered). */
  synthModel: string;
  verifyModel: string;
  /** Nominal per-run LLM-call belt; the hard guard is the ledger CostCeilingError. */
  maxLlmCallsPerRun: number;
  /** Number of expert lenses (for the per-round call estimate). */
  lensCount: number;
  /** Per-asset USD budget for a single deepen run (checked between rounds against the ledger). */
  deepenBudgetUsd: number;
  /** Enrichment bounds: max targeted Perplexity queries and appended-evidence chars per round. */
  enrichPerplexityBudget: number;
  enrichCharBudget: number;
  /** Owner policy: publish research that never cleared the bar after exhausting deepening.
   *  FALSE = below-bar/exhausted rests at `in_review` for admin (the residual soft gate). */
  publishBelowBarAfterExhaustion: boolean;
  /** Terminal status the desk flips a committed asset to. */
  publishStatus: "published";
  /** When true, an LLM "desk manager" runs the deepening (decides each round's move + when it's
   *  confidently done) instead of the fixed ladder. */
  managerEnabled: boolean;
  managerModel: string;
  /** Grounding gate (pipeline upgrade §2): minimum fraction of load-bearing claims that must be
   *  SUPPORTED by evidence for an "auto" recommendation to survive. Below this, the thesis is held
   *  for review however confident it sounds — a confident-but-ungrounded view never auto-publishes. */
  minGroundedCoverage: number;
  /** When true, the retrieval planner fetches the facts a thesis needs BEFORE the desk runs. */
  retrievalPlannerEnabled: boolean;
}

export const DESK_CONFIG: DeskConfig = {
  confidenceBar: 0.75,
  maxContradicted: 0,
  maxRounds: 5,
  ladder: ["enrich", "relens", "bump_tier"],
  levers: { enrich: true, relens: true, bump_tier: true },
  lensTierLadder: ["claude-sonnet-4-6", "claude-opus-4-8"],
  synthModel: "claude-opus-4-8",
  verifyModel: "claude-opus-4-8",
  maxLlmCallsPerRun: 42,
  lensCount: 4,
  deepenBudgetUsd: 4,
  enrichPerplexityBudget: 2,
  enrichCharBudget: 8000,
  publishBelowBarAfterExhaustion: false,
  publishStatus: "published",
  managerEnabled: true,
  managerModel: "claude-opus-4-8",
  minGroundedCoverage: 0.5,
  retrievalPlannerEnabled: true,
};
