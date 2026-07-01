// pg-boss worker: processes queued jobs (the self-hosted orchestrator, spec §7.1).
// Runs as it-v1-worker.service. Usage (manual): npm run worker
import { loadEnv } from "../lib/env";
import { getBoss, stopBoss } from "../lib/queue/boss";
import { JOB } from "../lib/queue/types";
import { handleCoveragePass, type CoverageJobData } from "../lib/jobs/coverage";
import { handleProfilePass, type ProfileJobData } from "../lib/jobs/profile";
import { handleSentimentRun, type SentimentJobData } from "../lib/jobs/sentiment";
import { handleOnboard, type OnboardJobData } from "../lib/jobs/onboard";
import { handleGenerateContent, type ContentJobData } from "../lib/jobs/content";

loadEnv();
const boss = await getBoss();

await boss.work(JOB.COVERAGE_PASS, async (jobs) => {
  for (const job of jobs) {
    // Engine 2 (Fundamental Research) coverage pass on filing arrival (Phase 4).
    try {
      const r = await handleCoveragePass(job.data as CoverageJobData);
      console.log(`[worker] ${JOB.COVERAGE_PASS} ok`, JSON.stringify(r));
    } catch (err) {
      console.error(`[worker] ${JOB.COVERAGE_PASS} failed`, (err as Error).message);
      throw err; // let pg-boss retry
    }
  }
});

await boss.work(JOB.PROFILE_PASS, async (jobs) => {
  for (const job of jobs) {
    // Perplexity research profile for a private / pre-IPO name (intake).
    try {
      const r = await handleProfilePass(job.data as ProfileJobData);
      console.log(`[worker] ${JOB.PROFILE_PASS} ${r.ok ? "ok" : "degraded"}`, JSON.stringify(r));
    } catch (err) {
      console.error(`[worker] ${JOB.PROFILE_PASS} failed`, (err as Error).message);
      throw err;
    }
  }
});

await boss.work(JOB.SENTIMENT_RUN, async (jobs) => {
  for (const job of jobs) {
    // Engine 4 (Brand/Sentiment) escalated window on a major event (Phase 7).
    try {
      const r = await handleSentimentRun(job.data as SentimentJobData);
      console.log(`[worker] ${JOB.SENTIMENT_RUN} ok`, JSON.stringify({ company_id: r.company_id, gap: r.gap.direction, confidence: r.confidence, degraded: r.degraded.length }));
    } catch (err) {
      console.error(`[worker] ${JOB.SENTIMENT_RUN} failed`, (err as Error).message);
      throw err;
    }
  }
});

// Onboard is the heavy per-asset pipeline; process a small batch CONCURRENTLY so several companies
// build clarity in parallel (bounded — each runs the desk manager + deepening against the budget).
await boss.work(JOB.ONBOARD_ASSET, { batchSize: 3 }, async (jobs) => {
  await Promise.all(jobs.map(async (job) => {
    try {
      const r = await handleOnboard(job.data as OnboardJobData);
      console.log(`[worker] ${JOB.ONBOARD_ASSET} ${r.status}`, JSON.stringify({ company_id: r.company_id, steps: r.steps.map((s) => `${s.step}:${s.status}`) }));
    } catch (err) {
      console.error(`[worker] ${JOB.ONBOARD_ASSET} failed`, (err as Error).message);
      throw err;
    }
  }));
});

await boss.work(JOB.GENERATE_CONTENT, async (jobs) => {
  for (const job of jobs) {
    // Workstream C auto-commit: build the content spider from a desk-approved snapshot.
    try {
      const r = await handleGenerateContent(job.data as ContentJobData);
      console.log(`[worker] ${JOB.GENERATE_CONTENT} ${r.built ? "built" : r.skipped ? "skipped" : r.suppressed ? "suppressed" : "noop"}`, JSON.stringify(r));
    } catch (err) {
      console.error(`[worker] ${JOB.GENERATE_CONTENT} failed`, (err as Error).message);
      throw err; // transient — let pg-boss retry
    }
  }
});

console.log(`[worker] started; subscribed to: ${Object.values(JOB).join(", ")}`);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    console.log(`[worker] ${sig} — stopping`);
    await stopBoss();
    process.exit(0);
  });
}
