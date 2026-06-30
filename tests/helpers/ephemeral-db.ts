import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { migrate } from "../../lib/db/migrate";
import { seedGics } from "../../lib/gics/taxonomy";

export interface Ephemeral {
  url: string;
  pool: Pool;
  drop: () => Promise<void>;
}

/**
 * Create a throwaway database (migrated + GICS-seeded) for integration tests, then drop it.
 * Uses the it_v1 role's CREATEDB privilege; new DBs inherit pgvector from template1.
 */
export async function createEphemeralDb(): Promise<Ephemeral> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL not set (vitest.setup loads .env)");
  const adminUrl = base.replace(/\/[^/]+$/, "/postgres");
  const name = `it_v1_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = base.replace(/\/[^/]+$/, `/${name}`);
  const pool = new Pool({ connectionString: url });
  await migrate(pool, { silent: true });
  await seedGics(pool);

  return {
    url,
    pool,
    drop: async () => {
      await pool.end();
      const a = new Client({ connectionString: adminUrl });
      await a.connect();
      // Avoid DROP ... WITH (FORCE): it terminates EVERY backend on the DB, and the non-superuser
      // it_v1 role can't signal backends it doesn't own → "permission denied to terminate process"
      // under parallel test load. Instead block new connections, terminate only our own lingering
      // sessions (always permitted), then plain-DROP with a short retry.
      await a.query("UPDATE pg_database SET datallowconn = false WHERE datname = $1", [name]).catch(() => {});
      await a.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [name],
      ).catch(() => {});
      for (let attempt = 0; ; attempt++) {
        try {
          await a.query(`DROP DATABASE IF EXISTS ${name}`);
          break;
        } catch (err) {
          if (attempt >= 5) { await a.end(); throw err; }
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
      await a.end();
    },
  };
}
