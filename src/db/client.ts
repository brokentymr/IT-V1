import pg from 'pg';

/**
 * Single shared connection pool to the proprietary knowledge base (section 7.1).
 * DATABASE_URL points at self-hosted Postgres + pgvector or DO Managed Postgres.
 */
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (see .env.example)');
    }
    pool = new pg.Pool({ connectionString });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as any[]);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
