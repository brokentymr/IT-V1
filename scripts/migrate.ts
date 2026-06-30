// Apply pending SQL migrations to the database in DATABASE_URL.
// Usage: npm run migrate
import { loadEnv } from "../lib/env";
import { getPool, closePool } from "../lib/db/pool";
import { migrate } from "../lib/db/migrate";

loadEnv();
const pool = getPool();
try {
  await migrate(pool);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closePool();
}
