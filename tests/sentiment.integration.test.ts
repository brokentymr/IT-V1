import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { parseStockTwits, parseGdeltTone, StockTwitsAdapter, GdeltToneAdapter } from "../lib/sources/sentiment";
import type { JsonFetcher } from "../lib/sources/types";
import { runSentiment } from "../lib/engines/sentiment";
import type { SentimentAnalyzer, SentimentSynthesis, Gap } from "../lib/engines/sentiment_analyzer";
import { loadOpenAreas } from "../lib/engines/areas_of_interest";
import { fakeNews, fakeAnalyzer, FakeQueue } from "./helpers/fakes";
import { runDailyMonitor } from "../lib/engines/news_monitor";
import type { NewsArticle } from "../lib/sources/news";

const NOW = Date.UTC(2026, 5, 30, 12, 0, 0);
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

const stFetcher = (msgs: unknown[]): JsonFetcher => async () => ({ status: 200, body: { messages: msgs } });
const gdeltFetcher = (bins: unknown[]): JsonFetcher => async () => ({ status: 200, body: { tonechart: bins } });
const fail404: JsonFetcher = async () => ({ status: 404, body: null });

const fakeSentimentAnalyzer = (gap: Gap): SentimentAnalyzer => ({
  async synthesize({ platforms }): Promise<SentimentSynthesis> {
    return { by_platform_themes: platforms.map((p) => ({ platform: p.platform, top_themes: [`theme-${p.platform}`] })), ground_momentum: "Retail piling in.", gap };
  },
});

const ST_MSGS = [
  { created_at: iso(1), body: "AAA to the moon", entities: { sentiment: { basic: "Bullish" } } },
  { created_at: iso(2), body: "loading calls", entities: { sentiment: { basic: "Bullish" } } },
  { created_at: iso(3), body: "puts here", entities: { sentiment: { basic: "Bearish" } } },
  { created_at: iso(40), body: "stale", entities: { sentiment: { basic: "Bearish" } } }, // out of window
];

describe("Engine 4 — Brand/Sentiment (Phase 7)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};

  async function mk(ticker: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ($1,$1,$2,$3,$4,'monitoring','Information Technology','listed') RETURNING id`,
      [ticker, { legal_name: ticker, tickers: [ticker] }, { gics_sector: "Information Technology" }, { status: "monitoring", positions_held: [] }],
    );
    return rows[0].id;
  }
  async function seedNote(companyId: string, effect: string, daysAgo: number) {
    await db.pool.query(
      `INSERT INTO news_notes (company_id, detected_at, category, origin_kind, importance_score, status, content)
       VALUES ($1, $2, 'guidance', 'primary', 50, 'flagged', $3)`,
      [companyId, iso(daysAgo), JSON.stringify({ headline: `note ${effect}`, impact_analysis: { thesis_effect: effect } })],
    );
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.AAA = await mk("AAA");
    id.BBB = await mk("BBB");
    await db.pool.query(
      "INSERT INTO company_links (from_company_id,to_company_id,type,cross_sector,strength,status) VALUES ($1,$2,'supplier',false,'medium','active')",
      [id.AAA, id.BBB],
    );
    for (const [e, d] of [["supports", 1], ["supports", 2], ["pressures", 3]] as Array<[string, number]>) await seedNote(id.AAA, e, d);
    await seedNote(id.BBB, "supports", 1); // so the degrade test isolates the GDELT failure
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("parses StockTwits + GDELT payloads", () => {
    expect(parseStockTwits({ messages: ST_MSGS }).length).toBe(4);
    expect(parseGdeltTone({ tonechart: [{ bin: -2, count: 5 }, { bin: 6, count: 15 }] })).toEqual({ avg_tone: 4, volume: 20 });
    expect(parseGdeltTone({ tonechart: [] })).toBeNull();
  });

  it("runs all three platforms, writes brand_sentiment, opens a sentiment_gap area on a high gap", async () => {
    const r = await runSentiment({
      companyId: id.AAA, now: NOW,
      stocktwits: new StockTwitsAdapter(stFetcher(ST_MSGS)),
      gdelt: new GdeltToneAdapter(gdeltFetcher([{ bin: -2, count: 5 }, { bin: 6, count: 15 }])),
      analyzer: fakeSentimentAnalyzer({ direction: "sentiment_ahead", magnitude: "high", rationale: "Crowd euphoric vs soft fundamentals." }),
    });

    expect(r.by_platform.map((p) => p.platform).sort()).toEqual(["gdelt", "news", "stocktwits"]);
    expect(r.confidence).toBe(1);
    expect(r.degraded.length).toBe(0);
    const st = r.by_platform.find((p) => p.platform === "stocktwits")!;
    expect(st.volume).toBe(3);                 // stale message excluded by window
    expect(st.sentiment).toBeCloseTo(0.33, 1); // bull2 bear1
    expect(st.top_themes).toContain("theme-stocktwits");
    expect(r.gap.direction).toBe("sentiment_ahead");
    expect(r.area_opened).toBe(true);

    // persisted on the canonical file
    const cf = await db.pool.query<{ bs: { ground_momentum: string; sentiment_vs_fundamentals_gap: { magnitude: string }; confidence: number } }>(
      "SELECT current_events->'brand_sentiment' AS bs FROM canonical_files WHERE company_id=$1", [id.AAA],
    );
    expect(cf.rows[0].bs.ground_momentum).toBe("Retail piling in.");
    expect(cf.rows[0].bs.sentiment_vs_fundamentals_gap.magnitude).toBe("high");
    // the gap became a tracked area of interest
    expect((await loadOpenAreas(id.AAA)).some((a) => a.theme === "sentiment_gap")).toBe(true);
  });

  it("degrades gracefully: a dead platform lowers confidence and is flagged, never fails", async () => {
    const r = await runSentiment({
      companyId: id.BBB, now: NOW,
      stocktwits: new StockTwitsAdapter(stFetcher(ST_MSGS)),
      gdelt: new GdeltToneAdapter(fail404), // dead
      analyzer: fakeSentimentAnalyzer({ direction: "aligned", magnitude: "low", rationale: "ok" }),
    });
    expect(r.by_platform.some((p) => p.platform === "gdelt")).toBe(false);
    expect(r.degraded.length).toBeGreaterThan(0);
    expect(r.confidence).toBeCloseTo(0.7, 5); // 1 - 0.3*(gdelt + news-empty)? gdelt only here
  });

  it("escalation: a major event enqueues a sentiment run for the origin AND the read-through asset", async () => {
    const queue = new FakeQueue();
    const news = fakeNews({ AAA: [{ title: "AAA cuts guidance sharply", url: "u", source: "R", published_at: iso(0), snippet: "x", provider: "google_news" } as NewsArticle] });
    const analyzer = fakeAnalyzer({ score: () => 85, category: "guidance", readThrough: (n) => ({ material: n === "BBB", materiality: "high" }) });

    await runDailyMonitor({ analyzer, news, queue, companyIds: [id.AAA] });
    const sentimentJobs = queue.jobs.filter((j) => j.name === "sentiment-run").map((j) => (j.data as { company_id: string }).company_id);
    expect(sentimentJobs).toContain(id.AAA); // origin (major)
    expect(sentimentJobs).toContain(id.BBB); // major-band read-through neighbor
  });
});
