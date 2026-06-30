#!/usr/bin/env node
// Phase 0 health check (BUILD-PLAN §4, Phase 0 testing milestone).
// Confirms: (a) Postgres reachable + pgvector present, (b) DO Spaces PUT/GET round-trip,
// (c) a 1-token Claude API call returns 200, (d) the app serves over HTTP.
// Run: node --env-file=.env scripts/health-check.mjs   (or `npm run health` after loading .env)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

// --- load .env if the runtime didn't (so `npm run health` works without --env-file) ---
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* .env optional if env already populated */
}

const APP_URL = process.env.APP_HEALTH_URL ?? "http://localhost:3000";
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

// (a) Postgres + pgvector
try {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  );
  await client.end();
  const v = rows[0]?.extversion;
  record("a. Postgres + pgvector", !!v, v ? `pgvector ${v}` : "pgvector extension missing");
} catch (err) {
  record("a. Postgres + pgvector", false, err.message);
}

// (b) DO Spaces round-trip (PUT then GET) — needs Spaces creds (from the doctl token)
const spacesReady =
  process.env.SPACES_KEY && process.env.SPACES_SECRET &&
  process.env.SPACES_BUCKET && process.env.SPACES_ENDPOINT;
if (!spacesReady) {
  record("b. DO Spaces round-trip", null, "skipped — pending doctl token + Spaces keys");
} else {
  try {
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
      await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      region: process.env.SPACES_REGION ?? "us-east-1",
      endpoint: process.env.SPACES_ENDPOINT,
      credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET },
      forcePathStyle: false,
    });
    const Key = `health-check/${process.pid}-${Date.now()}.txt`;
    const Bucket = process.env.SPACES_BUCKET;
    const body = "it-v1 health check";
    await s3.send(new PutObjectCommand({ Bucket, Key, Body: body }));
    const got = await s3.send(new GetObjectCommand({ Bucket, Key }));
    const text = await got.Body.transformToString();
    await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    record("b. DO Spaces round-trip", text === body, text === body ? "PUT/GET/DELETE ok" : "content mismatch");
  } catch (err) {
    record("b. DO Spaces round-trip", false, err.message);
  }
}

// (c) Claude API — 1-token call returns 200
try {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  record("c. Claude API (1 token)", res.status === 200, `HTTP ${res.status}`);
} catch (err) {
  record("c. Claude API (1 token)", false, err.message);
}

// (d) App serves over HTTP
try {
  const res = await fetch(APP_URL, { redirect: "manual" });
  record("d. App over HTTP", res.ok, `${APP_URL} → HTTP ${res.status}`);
} catch (err) {
  record("d. App over HTTP", false, err.message);
}

// --- report ---
console.log("\nPhase 0 health check\n" + "=".repeat(48));
let failed = 0;
for (const r of results) {
  const mark = r.ok === null ? "○ SKIP" : r.ok ? "✓ PASS" : "✗ FAIL";
  if (r.ok === false) failed++;
  console.log(`${mark}  ${r.name.padEnd(26)} ${r.detail ?? ""}`);
}
console.log("=".repeat(48));
console.log(failed === 0 ? "All required checks green.\n" : `${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
