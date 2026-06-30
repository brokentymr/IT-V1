import PgBoss from "pg-boss";
import { JOB, type JobName, type Queue } from "./types";

// Self-hosted pg-boss queue on the app Postgres (spec §7.1). Singleton; queues are
// created on first start.
let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (!starting) {
    starting = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL not set");
      const b = new PgBoss({ connectionString });
      b.on("error", (err) => console.error("[pg-boss]", err));
      await b.start();
      for (const name of Object.values(JOB)) await b.createQueue(name);
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

/** The production Queue, backed by pg-boss. */
export const bossQueue: Queue = {
  async enqueue(name: JobName, data) {
    const b = await getBoss();
    return b.send(name, data);
  },
};
