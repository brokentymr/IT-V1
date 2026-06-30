import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { listUniverse, universeFacets } from "../lib/views/universe";
import { getCompanyDetail } from "../lib/views/company";
import { getRecentCoverage, getFeeds } from "../lib/views/jobs";

// Seed a small but complete canonical file + graph, then assert the screens' read models surface it.
describe("operator console read models (integration)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};
  let snapshotId: string;

  async function mkCompany(ticker: string, sector: string, status: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, cik, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ticker, `000${ticker}`, { legal_name: ticker, tickers: [ticker] },
        { gics_sector: sector, industry_group: null, industry: null, sub_industry: null },
        { status, authors: [], positions_held: [] }, status, sector],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.AAPL = await mkCompany("AAPL", "Information Technology", "monitoring");
    id.HPQ = await mkCompany("HPQ", "Information Technology", "watchlist");

    const cf = await db.pool.query<{ id: string }>(
      "INSERT INTO canonical_files (company_id, current_events) VALUES ($1,$2) RETURNING id",
      [id.AAPL, { rolling_outlook: "Services-led", forward_note: null }],
    );
    const content = {
      fundamentals: { model: { fiscal_period: "Q2 2026", line_items: { revenue: { label: "Revenue", value: 111_184_000_000, unit: "USD", yoy: { change_pct: 0.05 } } }, ratios: { net_margin: 0.26 } }, provenance: [] },
      market_context: { consensus: { summary: "Street sees $108.9B" }, analyst_view: { summary: "Wide moat, FV $270" }, provenance: [] },
      scenario: { target_period: "2026-07-30", bands: { revenue: { p10: 84e9, p50: 109e9, p90: 133e9 }, net_income: { p10: 20e9, p50: 28e9, p90: 40e9 } }, beat_probability: { revenue: 0.9, eps: 0.53 }, sensitivity: [{ driver: "Product revenue", metric: "revenue", contribution: 0.8 }], watch_items: ["Watch product revenue"], provenance: [] },
      thesis: { one_liner: "Margin-led compounder", long_form: "Long.", tensions: ["China"], invalidation_triggers: ["Net margin < 22%"], conviction: 4, catalysts: [], positions_held: [] },
    };
    snapshotId = randomUUID();
    await db.pool.query(
      `INSERT INTO canonical_snapshots (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, filing_ref, content, diff)
       VALUES ($1,$2,$3,'2026-03-28','10-Q Q2 2026','manual',4,'ACC',$4,$5)`,
      [snapshotId, cf.rows[0].id, id.AAPL, content,
        { metrics: [{ key: "revenue", label: "Revenue", prior: 100e9, current: 111.184e9, change_pct: 0.11, direction: "up" }] }],
    );

    await db.pool.query(
      "INSERT INTO company_links (from_company_id,to_company_id,type,cross_sector,strength,status) VALUES ($1,$2,'customer',false,'medium','active')",
      [id.AAPL, id.HPQ],
    );
    // a read-through note on HPQ originating from AAPL, + a primary note on AAPL
    const rtContent = { id: randomUUID(), company_id: id.HPQ, detected_at: new Date().toISOString(), source_ref: randomUUID(), headline: "Read-through: AAPL filing", summary: "margins", category: "guidance", origin: { kind: "read_through", origin_event_ref: snapshotId, origin_company_id: id.AAPL, link_type: "customer" }, importance_score: 60, importance_rationale: "x", impact_analysis: { forward_outlook: "", thesis_effect: "pressures", invalidation_trigger_hit: null, sentiment_effect: "", estimated_magnitude: "medium" }, read_through: [], status: "flagged" };
    await db.pool.query(
      "INSERT INTO news_notes (company_id, source_ref, category, origin_kind, origin_company_id, importance_score, status, content) VALUES ($1,null,'guidance','read_through',$2,60,'flagged',$3)",
      [id.HPQ, id.AAPL, rtContent],
    );
    const primaryContent = { ...rtContent, id: randomUUID(), company_id: id.AAPL, headline: "Apple ships chips", origin: { kind: "primary", origin_event_ref: null, origin_company_id: null, link_type: null } };
    await db.pool.query(
      "INSERT INTO news_notes (company_id, source_ref, category, origin_kind, origin_company_id, importance_score, status, content) VALUES ($1,null,'product','primary',null,55,'flagged',$2)",
      [id.AAPL, primaryContent],
    );
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("Universe lists the asset with a one-liner, conviction, and link count", async () => {
    const rows = await listUniverse();
    const aapl = rows.find((r) => r.primary_ticker === "AAPL")!;
    expect(aapl.one_liner).toBe("Margin-led compounder");
    expect(aapl.conviction).toBe(4);
    expect(aapl.link_count).toBe(1);
    expect(aapl.coverage_status).toBe("monitoring");
    // faceted filter
    expect((await listUniverse({ status: "watchlist" })).map((r) => r.primary_ticker)).toEqual(["HPQ"]);
    const facets = await universeFacets();
    expect(facets.statuses).toContain("monitoring");
  });

  it("Company detail assembles the nested canonical file + read-through relationship", async () => {
    const d = (await getCompanyDetail(id.AAPL))!;
    expect(d.header.coverage_status).toBe("monitoring");
    const content = d.latest!.content as { scenario?: { beat_probability?: { revenue: number } }; thesis?: { one_liner?: string } };
    expect(content.thesis?.one_liner).toBe("Margin-led compounder");
    expect(content.scenario?.beat_probability?.revenue).toBe(0.9);
    expect(d.relationships[0].to_ticker).toBe("HPQ");
    expect(d.relationships[0].readthrough_count).toBe(1); // a real read-through traveled the edge
    expect(d.feed.some((n) => n.headline === "Apple ships chips" && n.origin_kind === "primary")).toBe(true);
  });

  it("exercises the human checkpoint: an approval (with an edit) surfaces on the company", async () => {
    await db.pool.query(
      `INSERT INTO thesis_approvals (snapshot_id, company_id, edited_thesis, note)
       VALUES ($1,$2,$3,'looks good')
       ON CONFLICT (snapshot_id) DO UPDATE SET edited_thesis = EXCLUDED.edited_thesis, note = EXCLUDED.note`,
      [snapshotId, id.AAPL, JSON.stringify({ one_liner: "Operator-edited thesis" })],
    );
    const d = (await getCompanyDetail(id.AAPL))!;
    expect(d.approval).not.toBeNull();
    expect(d.approval!.note).toBe("looks good");
    expect((d.approval!.edited_thesis as { one_liner: string }).one_liner).toBe("Operator-edited thesis");
  });

  it("Pipeline read models surface recent coverage + news feed", async () => {
    const cov = await getRecentCoverage();
    expect(cov.some((c) => c.company_id === id.AAPL && c.cycle_label === "10-Q Q2 2026")).toBe(true);
    const feeds = await getFeeds();
    expect(feeds.news.some((n) => n.label === "Apple ships chips")).toBe(true);
  });
});
