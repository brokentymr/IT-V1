import PgBoss from "pg-boss";
import { JOB, type JobName, type Queue } from "./types";
import { query } from "../db/pool";

// Self-hosted pg-boss queue on the app Postgres (spec §7.1). Singleton; queues are
// created on first start.
let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

// Per-company work (coverage/onboard/profile/content) must be deduped by singletonKey so a
// double-click or timer collision can't run two deepening passes → two snapshots/publishes. pg-boss
// only honors singletonKey under a non-standard policy; 'stately' enforces uniqueness per
// (name, singleton_key) so distinct companies still run concurrently. createQueue is ON CONFLICT DO
// NOTHING, so we ALSO updateQueue to set the policy on queues created by earlier (standard) starts.
const SERIALIZED = new Set<string>([JOB.COVERAGE_PASS, JOB.ONBOARD_ASSET, JOB.PROFILE_PASS, JOB.GENERATE_CONTENT]);

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!starting) {
    starting = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL not set");
      const b = new PgBoss({ connectionString });
      b.on("error", (err) => console.error("[pg-boss]", err));
      await b.start();
      for (const name of Object.values(JOB)) {
        const policy: PgBoss.QueuePolicy = SERIALIZED.has(name) ? "stately" : "standard";
        await b.createQueue(name, { name, policy });
        await b.updateQueue(name, { name, policy });
      }
      boss = b;
      return b;
    })();
  }
  return starting;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = undefined;
    starting = undefined;
  }
}

/** Stop all queued/active work for a company. The app tables cascade-delete with the company row,
 *  but pg-boss keeps its own schema (no FK to companies), so a pending onboard/coverage/content job
 *  would otherwise keep running against a ghost. We delete every per-company job (matched on the
 *  `company_id` payload) that hasn't already finished. Returns how many jobs were dropped. Deleting an
 *  'active' job is safe: pg-boss ignores the completion of a row it can no longer find, and the handler
 *  itself fails cleanly when its next write hits the now-deleted company. */
export async function cancelCompanyJobs(companyId: string): Promise<number> {
  const names = Object.values(JOB) as string[];
  const res = await query(
    `DELETE FROM pgboss.job
      WHERE name = ANY($1::text[])
        AND data->>'company_id' = $2
        AND state IN ('created', 'retry', 'active')`,
    [names, companyId],
  );
  return res.rowCount ?? 0;
}

/** The production Queue, backed by pg-boss. */
export const bossQueue: Queue = {
  async enqueue(name: JobName, data, opts) {
    const b = await getBoss();
    // singletonKey dedupes per-company work on the 'stately'-policy queues (see SERIALIZED above):
    // a second enqueue with the same key while one is still pending returns null instead of creating
    // a duplicate job. Requires the non-standard policy set in getBoss(); inert on 'standard' queues.
    return b.send(name, data, opts?.singletonKey ? { singletonKey: opts.singletonKey } : {});
  },
};
