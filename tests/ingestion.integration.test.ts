import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fixtureSec } from "./helpers/sec-fixture";
import { setPool } from "../lib/db/pool";
import { ingestCompany } from "../lib/engines/ingestion";

// The Phase 1 testing milestone: migrate → seed GICS → run Engine 1 on a real ticker →
// assert company + canonical skeleton + seeded peer links + correct GICS path + provenance.
describe("Engine 1 — Ingestion (integration: ephemeral Postgres + SEC fixtures)", () => {
  let db: Ephemeral;

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool); // redirect the shared pool at the throwaway database
  });
  afterAll(async () => {
    setPool(undefined);
    await db.drop();
  });

  it("seeded the GICS taxonomy (11 sectors + 25 groups)", async () => {
    const { rows } = await db.pool.query<{ level: string; c: string }>(
      "SELECT level, count(*)::int c FROM sectors GROUP BY level",
    );
    const byLevel = Object.fromEntries(rows.map((r) => [r.level, Number(r.c)]));
    expect(byLevel.sector).toBe(11);
    expect(byLevel.industry_group).toBe(25);
  });

  it("ingests AAPL: company + canonical skeleton + provenance with the correct GICS path", async () => {
    const r = await ingestCompany("AAPL", { sec: fixtureSec() });
    expect(r.status).toBe("created");
    expect(r.legal_name).toBe("Apple Inc.");
    expect(r.classification.gics_sector).toBe("Information Technology");
    expect(r.classification.industry_group).toBe("Technology Hardware & Equipment");
    expect(r.classification_confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.flagged).toBe(false);

    const { rows: comp } = await db.pool.query("SELECT * FROM companies WHERE primary_ticker='AAPL'");
    expect(comp).toHaveLength(1);
    expect(comp[0].cik).toBe("0000320193");
    expect(comp[0].canonical_file_ref).toBeTruthy();

    const { rows: cf } = await db.pool.query("SELECT * FROM canonical_files WHERE company_id=$1", [comp[0].id]);
    expect(cf).toHaveLength(1);
    expect(cf[0].current_events.rolling_outlook).toBe("");

    const { rows: src } = await db.pool.query("SELECT * FROM sources WHERE company_id=$1", [comp[0].id]);
    expect(src.length).toBeGreaterThanOrEqual(1);
    expect(src[0].origin).toBe("SEC EDGAR");
    expect(src[0].url).toContain("data.sec.gov");
  });

  it("ingests HPQ and seeds bidirectional thematic_peer links to AAPL (same GICS group)", async () => {
    const r = await ingestCompany("HPQ", { sec: fixtureSec() });
    expect(r.classification.industry_group).toBe("Technology Hardware & Equipment");
    expect(r.links_created).toBe(2);

    const { rows } = await db.pool.query(
      `SELECT cf.primary_ticker AS f, ct.primary_ticker AS t, cl.type, cl.cross_sector
         FROM company_links cl
         JOIN companies cf ON cf.id = cl.from_company_id
         JOIN companies ct ON ct.id = cl.to_company_id
        ORDER BY f, t`,
    );
    expect(rows).toEqual([
      { f: "AAPL", t: "HPQ", type: "thematic_peer", cross_sector: false },
      { f: "HPQ", t: "AAPL", type: "thematic_peer", cross_sector: false },
    ]);
  });

  it("is idempotent: re-ingesting AAPL updates in place without duplicating", async () => {
    const r = await ingestCompany("AAPL", { sec: fixtureSec() });
    expect(r.status).toBe("updated");
    expect(r.links_created).toBe(0); // peer link already exists
    const { rows } = await db.pool.query<{ n: string }>(
      "SELECT count(*)::int n FROM companies WHERE primary_ticker='AAPL'",
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
