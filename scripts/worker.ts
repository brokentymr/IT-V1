// pg-boss worker: processes queued jobs (the self-hosted orchestrator, spec §7.1).
// Runs as it-v1-worker.service. Usage (manual): npm run worker
import { loadEnv } from "../lib/env";
import { getBoss, stopBoss } from "../lib/queue/boss";
import { JOB } from "../lib/queue/types";

loadEnv();
const boss = await getBoss();

await boss.work(JOB.COVERAGE_PASS, async (jobs) => {
  for (const job of jobs) {
    // Phase 2: placeholder. Engine 2 (Fundamental Research) runs the coverage pass in Phase 4.
    console.log(`[worker] ${JOB.COVERAGE_PASS}`, JSON.stringify(job.data));
  }
});

await boss.work(JOB.SENTIMENT_RUN, async (jobs) => {
  for (const job of jobs) {
    // Phase 3: placeholder. Engine 4 (Brand/Sentiment) runs the escalated window in Phase 7.
    console.log(`[worker] ${JOB.SENTIMENT_RUN}`, JSON.stringify(job.data));
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
