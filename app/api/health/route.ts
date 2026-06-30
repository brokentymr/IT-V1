import { NextResponse } from "next/server";
import { Client } from "pg";

// Always evaluated at request time — this is a liveness/health probe.
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;

  // Postgres reachable + pgvector present
  try {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { rows } = await client.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
    );
    await client.end();
    checks.postgres = "ok";
    checks.pgvector = rows[0]?.extversion ? `ok (${rows[0].extversion})` : "missing";
    if (!rows[0]?.extversion) healthy = false;
  } catch (err) {
    checks.postgres = `error: ${(err as Error).message}`;
    healthy = false;
  }

  // Claude API key present (the live call is exercised by scripts/health-check.mjs)
  checks.anthropic_key = process.env.ANTHROPIC_API_KEY ? "present" : "missing";
  if (!process.env.ANTHROPIC_API_KEY) healthy = false;

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks, ts: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
