import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fixtureSec } from "./helpers/sec-fixture";
import { fakeNews, fakeAnalyzer, FakeQueue } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { ingestCompany } from "../lib/engines/ingestion";
import { runDailyMonitor } from "../lib/engines/news_monitor";
import type { NewsArticle } from "../lib/sources/news";

const art = (title: string, over: Partial<NewsArticle> = {}): NewsArticle => ({
  title, url: `https://ex/${encodeURIComponent(title)}`, source: "Reuters",
  published_at: "2026-06-30T00:00:00Z", snippet: title, provider: "google_news", ...over,
});

describe("Engine 3 — News & Events Monitor (integration)", () => {
  let db: Ephemeral;
  let aaplId: string;
  let hpqId: string;

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    await ingestCompany("AAPL", { sec: fixtureSec() });
    await ingestCompany("HPQ", { sec: fixtureSec() });
    await db.pool.query("UPDATE companies SET coverage_status='monitoring' WHERE primary_ticker IN ('AAPL','HPQ')");
    aaplId = (await db.pool.query("SELECT id FROM companies WHERE primary_ticker='AAPL'")).rows[0].id;
    hpqId = (await db.pool.query("SELECT id FROM companies WHERE primary_ticker='HPQ'")).rows[0].id;
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("grades → primary notes → escalates major → reads through to the peer → updates outlook", async () => {
    const news = fakeNews({
      AAPL: [art("Apple cuts full-year guidance"), art("Apple opens a new store")],
      HPQ: [],
    });
    const analyzer = fakeAnalyzer({
      score: (t) => (/guidance/i.test(t) ? 80 : 20),
      category: "guidance",
      readThrough: (n) => ({ material: n === "HP INC", materiality: "high" }),
    });
    const queue = new FakeQueue();
    const r = await runDailyMonitor({ analyzer, news, queue, maxArticles: 10 });

    expect(r.notes_created).toBe(2);
    // origin AAPL (major) + the major-band read-through to HPQ both escalate a sentiment run (spec §4.6)
    expect(r.escalations).toBe(2);
    const sentimentTargets = queue.jobs.filter((j) => j.name === "sentiment-run").map((j) => (j.data as { company_id: string }).company_id);
    expect(sentimentTargets).toContain(aaplId);
    expect(sentimentTargets).toContain(hpqId);
    expect(r.read_through_notes).toBe(1);

    const primary = await db.pool.query(
      "SELECT importance_score, status FROM news_notes WHERE company_id=$1 AND origin_kind='primary' ORDER BY importance_score DESC",
      [aaplId],
    );
    expect(primary.rows.map((x) => Number(x.importance_score))).toEqual([80, 20]);
    expect(primary.rows[0].status).toBe("escalated");

    const rt = await db.pool.query(
      "SELECT content FROM news_notes WHERE company_id=$1 AND origin_kind='read_through'",
      [hpqId],
    );
    expect(rt.rows).toHaveLength(1);
    expect(rt.rows[0].content.origin.origin_company_id).toBe(aaplId);
    expect(rt.rows[0].content.origin.link_type).toBe("thematic_peer");

    const cf = await db.pool.query("SELECT current_events FROM canonical_files WHERE company_id=$1", [aaplId]);
    expect(cf.rows[0].current_events.rolling_outlook).toContain("guidance");
    expect(cf.rows[0].current_events.last_monitored).toBeTruthy();
  });

  it("is idempotent across runs — dedupes by headline", async () => {
    const news = fakeNews({ AAPL: [art("Apple cuts full-year guidance")], HPQ: [] });
    const analyzer = fakeAnalyzer({ score: () => 80, readThrough: () => ({ material: false, materiality: "low" }) });
    const r = await runDailyMonitor({ analyzer, news, queue: new FakeQueue(), maxArticles: 10 });
    expect(r.skipped_duplicates).toBeGreaterThanOrEqual(1);
    expect(r.notes_created).toBe(0);
  });
});
