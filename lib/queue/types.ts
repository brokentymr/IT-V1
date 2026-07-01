/** Job queue contract (pg-boss in production; a fake in tests). */
export const JOB = {
  COVERAGE_PASS: "coverage-pass",       // Fundamental Research coverage pass on filing arrival (Engine 2, Phase 4)
  SENTIMENT_RUN: "sentiment-run",       // Brand/Sentiment escalation from a major news event (Engine 4, Phase 7)
  PROFILE_PASS: "profile-pass",         // Perplexity research profile for a private / pre-IPO name (intake)
  ONBOARD_ASSET: "onboard-asset",       // Auto-on-add: run the whole pipeline to build clarity (level-up B)
  GENERATE_CONTENT: "generate-content", // Auto-commit: build the content spider from a desk-approved snapshot (Workstream C)
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/** Optional enqueue controls. `singletonKey` serializes/dedupes work for the same key (e.g. per company),
 *  so a daily timer can't collide with an in-flight onboard/deepen. */
export interface EnqueueOptions { singletonKey?: string }

export interface Queue {
  enqueue(name: JobName, data: Record<string, unknown>, opts?: EnqueueOptions): Promise<string | null>;
}
