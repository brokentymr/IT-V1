import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fakeNews, fakeAnalyzer, FakeQueue } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { accumulateArea, loadOpenAreas, applyResolutions } from "../lib/engines/areas_of_interest";
import { runDailyMonitor } from "../lib/engines/news_monitor";
import type { NewsArticle } from "../lib/sources/news";

const art = (title: string): NewsArticle => ({
  title, url: `https://ex/${encodeURIComponent(title)}`, source: "Reuters",
  published_at: "2026-06-30T00:00:00Z", snippet: title, provider: "google_news",
});

describe("Areas of Interest (Phase 5.5)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};

  async function mkCompany(ticker: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,'monitoring','Information Technology') RETURNING id`,
      [ticker, { legal_name: ticker, tickers: [ticker] },
        { gics_sector: "Information Technology", industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] }],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.A = await mkCompany("AAA");
    id.B = await mkCompany("BBB");
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("accumulates by theme: distinct categories cluster as separate open areas; repeats pile on", async () => {
    const c = id.A;
    const open1 = await accumulateArea({ companyId: c, category: "product", band: "material", score: 55, headline: "Device price increase announced", url: "u1", summary: "prices up" });
    expect(open1.created).toBe(true);

    // Same theme, a hotter major headline → accumulates onto the SAME area (not a duplicate).
    const open2 = await accumulateArea({ companyId: c, category: "product", band: "major", score: 78, headline: "Product event underwhelms the street", url: "u2", summary: "soft event" });
    expect(open2.created).toBe(false);
    expect(open2.id).toBe(open1.id);

    // A different theme → its own open area (the cluster on one name).
    const open3 = await accumulateArea({ companyId: c, category: "management", band: "material", score: 60, headline: "Incoming CEO named", url: "u3", summary: "leadership change" });
    expect(open3.created).toBe(true);

    const areas = await loadOpenAreas(c);
    expect(areas.length).toBe(2); // product + management
    const product = areas.find((a) => a.theme === "product")!;
    expect(product.mentions).toBe(2);          // two headlines accumulated
    expect(product.band).toBe("major");        // escalated material → major
    expect(product.score).toBe(78);            // peak score kept
    const row = await db.pool.query("SELECT jsonb_array_length(headlines) n FROM areas_of_interest WHERE id=$1", [product.id]);
    expect(row.rows[0].n).toBe(2);             // both headlines retained
  });

  it("adjudication: resolves an overreaction, carries another forward; a carried area stays live", async () => {
    const c = id.A;
    const applied = await applyResolutions({
      companyId: c, accession: "acc-1", snapshotId: null as unknown as string, revisitAfter: "2026-09-30",
      resolutions: [
        { theme: "product", verdict: "overreaction", note: "numbers don't support the panic" },
        { theme: "management", verdict: "carry_forward", note: "watch the transition next quarter" },
      ],
    });
    expect(applied.resolved).toBe(1);
    expect(applied.carried).toBe(1);

    const open = await loadOpenAreas(c);
    expect(open.length).toBe(1);                          // product resolved out; management carried (still live)
    expect(open[0].theme).toBe("management");
    expect(open[0].status).toBe("carried_forward");

    const resolved = await db.pool.query("SELECT disposition, resolution_note, resolved_by_accession FROM areas_of_interest WHERE company_id=$1 AND status='resolved'", [c]);
    expect(resolved.rowCount).toBe(1);
    expect(resolved.rows[0].disposition).toBe("overreaction");
    expect(resolved.rows[0].resolved_by_accession).toBe("acc-1");
  });

  it("after resolution, a fresh headline on the same theme opens a NEW area (partial unique index)", async () => {
    const c = id.A;
    const reopened = await accumulateArea({ companyId: c, category: "product", band: "material", score: 50, headline: "New pricing round", url: "u4", summary: "again" });
    expect(reopened.created).toBe(true);                 // resolved one does not block a new open one
    const open = await loadOpenAreas(c);
    expect(open.filter((a) => a.theme === "product").length).toBe(1);
  });

  it("the monitor opens areas from material/major notes and skips low-importance ones", async () => {
    const c = id.B;
    const news = fakeNews({ BBB: [art("BBB cuts guidance sharply"), art("BBB opens a small store")] });
    const analyzer = fakeAnalyzer({ score: (t) => (/guidance/i.test(t) ? 75 : 15), category: "guidance" });
    const res = await runDailyMonitor({ analyzer, news, queue: new FakeQueue(), companyIds: [c] });

    expect(res.areas_opened).toBe(1);                    // only the material/major guidance note
    const open = await loadOpenAreas(c);
    expect(open.length).toBe(1);
    expect(open[0].theme).toBe("guidance");
    expect(open[0].title).toBe("BBB cuts guidance sharply");
  });
});
