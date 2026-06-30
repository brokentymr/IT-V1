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
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
