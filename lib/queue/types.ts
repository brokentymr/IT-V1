/** Job queue contract (pg-boss in production; a fake in tests). */
export const JOB = {
  COVERAGE_PASS: "coverage-pass", // Fundamental Research coverage pass on filing arrival (Engine 2, Phase 4)
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

export interface Queue {
  enqueue(name: JobName, data: Record<string, unknown>): Promise<string | null>;
}
