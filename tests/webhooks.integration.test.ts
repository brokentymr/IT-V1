import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fixtureSec } from "./helpers/sec-fixture";
import { setPool } from "../lib/db/pool";
import { ingestCompany } from "../lib/engines/ingestion";
import { processTradingViewWebhook } from "../lib/webhooks/tradingview";
import { processFilingWebhook } from "../lib/webhooks/filing";
import { hmacSha256Hex } from "../lib/webhooks/verify";
import type { BlobStore } from "../lib/webhooks/types";
import type { JobName, Queue } from "../lib/queue/types";

class FakeQueue implements Queue {
  jobs: Array<{ name: JobName; data: unknown }> = [];
  async enqueue(name: JobName, data: Record<string, unknown>) {
    this.jobs.push({ name, data });
    return `job-${this.jobs.length}`;
  }
}
class FakeStore implements BlobStore {
  puts: Array<{ key: string; body: string }> = [];
  async put(key: string, body: string) {
    this.puts.push({ key, body });
    return { key };
  }
}

const count = async (db: Ephemeral, sql: string, params: unknown[] = []) =>
  Number((await db.pool.query<{ n: string }>(sql, params)).rows[0].n);

describe("Webhooks (integration: ephemeral Postgres)", () => {
  let db: Ephemeral;
  const tvSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET as string;
  const filingSecret = process.env.FILING_WEBHOOK_SECRET as string;

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    await ingestCompany("AAPL", { sec: fixtureSec() }); // a company to route to
  });
  afterAll(async () => {
    setPool(undefined);
    await db.drop();
  });

  // ---- TradingView ----
  it("accepts a valid alert → signal_event + provenance", async () => {
    const body = JSON.stringify({
      secret: tvSecret, ticker: "AAPL", indicator: "RSI", signal: "oversold",
      timeframe: "1D", price: 195.3, id: "tv-1",
    });
    const r = await processTradingViewWebhook(body);
    expect(r.status).toBe("ok");

    const { rows: ev } = await db.pool.query("SELECT * FROM signal_events WHERE kind='tradingview_alert'");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.indicator).toBe("RSI");
    expect(await count(db, "SELECT count(*)::int n FROM sources WHERE kind='tradingview_alert'")).toBe(1);
  });

  it("rejects a bad secret with no rows written", async () => {
    const before = await count(db, "SELECT count(*)::int n FROM signal_events");
    const r = await processTradingViewWebhook(JSON.stringify({ secret: "wrong", ticker: "AAPL", id: "tv-x" }));
    expect(r.status).toBe("unauthorized");
    expect(await count(db, "SELECT count(*)::int n FROM signal_events")).toBe(before);
  });

  it("is idempotent on replay (same id → no second event)", async () => {
    const body = JSON.stringify({ secret: tvSecret, ticker: "AAPL", indicator: "RSI", signal: "oversold", timeframe: "1D", id: "tv-1" });
    const r = await processTradingViewWebhook(body);
    expect(r.status).toBe("duplicate");
    expect(await count(db, "SELECT count(*)::int n FROM signal_events WHERE kind='tradingview_alert'")).toBe(1);
  });

  it("retains an unrouted OHLC signal for a non-company symbol (e.g. NQ!), via URL secret", async () => {
    // URL-secret path (2nd arg); body carries no secret, just OHLCV.
    const body = JSON.stringify({ symbol: "NQ1!", tf: "3", o: 20000, h: 20010, l: 19990, c: 20005, v: 1234, t: "2026-06-30T04:00:00Z", id: "nq-1" });
    const r = await processTradingViewWebhook(body, tvSecret);
    expect(r.status).toBe("ok");
    expect(r.routed).toBe(false);
    expect(r.company_id).toBeNull();

    const { rows } = await db.pool.query("SELECT * FROM signal_events WHERE symbol='NQ1!'");
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBeNull();
    expect(rows[0].payload.ohlc).toEqual({ open: 20000, high: 20010, low: 19990, close: 20005, volume: 1234 });
  });

  // ---- Filing ----
  it("accepts an HMAC-signed filing → raw_document + provenance + enqueued coverage-pass", async () => {
    const queue = new FakeQueue();
    const store = new FakeStore();
    const body = JSON.stringify({
      cik: "0000320193", form_type: "10-Q", accession: "0000320193-26-000050",
      filing_url: "https://www.sec.gov/x", filed_at: "2026-06-30T00:00:00Z",
    });
    const r = await processFilingWebhook(body, hmacSha256Hex(body, filingSecret), { queue, store });
    expect(r.status).toBe("ok");
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].name).toBe("coverage-pass");
    expect(store.puts).toHaveLength(1);

    const { rows: docs } = await db.pool.query("SELECT * FROM raw_documents WHERE kind='filing'");
    expect(docs).toHaveLength(1);
    expect(docs[0].blob_ref).toContain("0000320193-26-000050");
  });

  it("rejects a bad HMAC with no doc and no job", async () => {
    const queue = new FakeQueue();
    const store = new FakeStore();
    const body = JSON.stringify({ cik: "0000320193", accession: "0000320193-26-000099" });
    const r = await processFilingWebhook(body, "sha256=deadbeef", { queue, store });
    expect(r.status).toBe("unauthorized");
    expect(queue.jobs).toHaveLength(0);
    expect(await count(db, "SELECT count(*)::int n FROM raw_documents WHERE metadata->>'accession'=$1", ["0000320193-26-000099"])).toBe(0);
  });

  it("is idempotent on a replayed filing accession (no re-enqueue, no duplicate doc)", async () => {
    const queue = new FakeQueue();
    const store = new FakeStore();
    const body = JSON.stringify({ cik: "0000320193", form_type: "10-Q", accession: "0000320193-26-000050" });
    const r = await processFilingWebhook(body, hmacSha256Hex(body, filingSecret), { queue, store });
    expect(r.status).toBe("duplicate");
    expect(queue.jobs).toHaveLength(0);
    expect(await count(db, "SELECT count(*)::int n FROM raw_documents WHERE metadata->>'accession'=$1", ["0000320193-26-000050"])).toBe(1);
  });
});
