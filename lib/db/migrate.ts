import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Apply every migrations/NNNN_*.sql file in filename order, exactly once.
 * Idempotent: filenames recorded in schema_migrations are skipped. Each file
 * runs inside its own transaction, so a failure leaves no partial migration.
 */
export async function migrate(pool: Pool, opts: { dir?: string; silent?: boolean } = {}): Promise<MigrateResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = (m: string) => { if (!opts.silent) console.log(m); };

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [] as string[];
    throw e;
  })).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const done = new Set(rows.map((r) => r.filename));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (done.has(file)) { alreadyApplied.push(file); continue; }
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
      log(`  applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  log(applied.length ? `${applied.length} migration(s) applied.` : "schema up to date.");
  return { applied, alreadyApplied };
}
