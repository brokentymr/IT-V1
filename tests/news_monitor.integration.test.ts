import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fixtureSec } from "./helpers/sec-fixture";
import { fakeNews, fakeAnalyzer, FakeQueue } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { ingestCompany } from "../lib/engines/ingestion";
import { runDailyMonitor } from "../lib/engines/news_monitor";
import { getCompanyDetail } from "../lib/views/company";
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

  it("entity gate stays a no-op for AAPL/HPQ (len>=3, not denylisted)", async () => {
    // A headline with NO Apple signal must still classify for AAPL because its ticker is not collision-prone.
    const news = fakeNews({ AAPL: [art("Unrelated market chatter with zero company signal")], HPQ: [] });
    const analyzer = fakeAnalyzer({ score: () => 55, category: "guidance", readThrough: () => ({ material: false, materiality: "low" }) });
    const r = await runDailyMonitor({ analyzer, news, queue: new FakeQueue(), companyIds: [aaplId] });
    expect(r.entity_gated).toBe(0);
    expect(r.notes_created).toBe(1);
  });
});

describe("Engine 3 — entity gate for collision-prone tickers (control P8)", () => {
  let db: Ephemeral;
  let muId: string;

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, markets, coverage, coverage_status, gics_sector, listing)
       VALUES ('Micron Technology, Inc.','MU',$1,$2,$3,$4,'monitoring','Information Technology','listed') RETURNING id`,
      [
        JSON.stringify({ legal_name: "Micron Technology, Inc.", tickers: ["MU"] }),
        JSON.stringify({ gics_sector: "Information Technology" }),
        JSON.stringify([{ exchange: "NASDAQ" }]),
        JSON.stringify({ status: "monitoring", authors: [], next_earnings_date: null, positions_held: [] }),
      ],
    );
    muId = rows[0].id;
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  const junkA = art("Local museum opens a new mu-themed exhibit downtown");
  const junkB = art("A profile of the greek letter and its usage");
  const legit = art("Micron Technology lifts semiconductor guidance for the year");

  it("drops junk (no LLM, no note), keeps the legit note, and grows ticker_collisions idempotently", async () => {
    const news = fakeNews({ MU: [junkA, junkB, legit] });
    const analyzer = fakeAnalyzer({ score: (t) => (/guidance/i.test(t) ? 80 : 20), category: "other", readThrough: () => ({ material: false, materiality: "low" }) });

    const r1 = await runDailyMonitor({ analyzer, news, queue: new FakeQueue(), companyIds: [muId], maxArticles: 10 });
    expect(r1.entity_gated).toBe(2);
    expect(r1.notes_created).toBe(1);

    const notes = await db.pool.query("SELECT content->>'headline' AS h FROM news_notes WHERE company_id=$1 AND origin_kind='primary'", [muId]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0].h).toContain("Micron");

    const c1 = await db.pool.query<{ term: string; hits: number }>("SELECT term, hits FROM ticker_collisions WHERE ticker='MU' ORDER BY term");
    expect(c1.rows).toHaveLength(2);
    expect(c1.rows.every((x) => Number(x.hits) === 1)).toBe(true);

    // Second identical run: junk re-gated, note deduped, and collisions bump hits WITHOUT new rows.
    const r2 = await runDailyMonitor({ analyzer, news, queue: new FakeQueue(), companyIds: [muId], maxArticles: 10 });
    expect(r2.entity_gated).toBe(2);
    expect(r2.notes_created).toBe(0);
    expect(r2.skipped_duplicates).toBe(1);

    const c2 = await db.pool.query<{ term: string; hits: number }>("SELECT term, hits FROM ticker_collisions WHERE ticker='MU' ORDER BY term");
    expect(c2.rows).toHaveLength(2);
    expect(c2.rows.every((x) => Number(x.hits) === 2)).toBe(true);
  });

  it("feed view hides low-importance 'other' notes and reports the filtered count", async () => {
    // Insert a low-importance 'other' note directly; it should be filtered from the feed, counted separately.
    await db.pool.query(
      `INSERT INTO news_notes (company_id, detected_at, category, origin_kind, importance_score, status, content)
       VALUES ($1, now(), 'other', 'primary', 10, 'logged', $2)`,
      [muId, JSON.stringify({ headline: "trivial other note", summary: "noise" })],
    );
    const d = await getCompanyDetail(muId);
    expect(d).not.toBeNull();
    expect(d!.feed.some((n) => n.headline === "trivial other note")).toBe(false);
    expect(d!.feed_filtered_count).toBeGreaterThanOrEqual(1);
    // the legit high-importance note is still shown
    expect(d!.feed.some((n) => (n.headline ?? "").includes("Micron"))).toBe(true);
  });
});
