import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fakeAnalyzer } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { propagateReadThrough } from "../lib/engines/read_through";

// Hand-built graph (verify depth limit, materiality gate, cross-sector follow):
//   A →B(peer,in-sector)  A →D(supplier,CROSS-sector)  A →F(peer)  A →G(peer)
//   B →C(peer)            C →E(peer)
// Verdicts: B high, D high, C medium, F immaterial, G material-but-LOW.
// Expect notes on B, D, C only. E excluded by depth (A→B→C→E = 3 hops > 2).
describe("read-through traversal (integration)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};

  async function mkCompany(ticker: string, sector: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,'monitoring',$5) RETURNING id`,
      [ticker,
        { legal_name: ticker, tickers: [ticker] },
        { gics_sector: sector, industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] },
        sector],
    );
    return rows[0].id;
  }
  async function mkLink(from: string, to: string, type: string, crossSector: boolean) {
    await db.pool.query(
      `INSERT INTO company_links (from_company_id,to_company_id,type,cross_sector,strength,status)
       VALUES ($1,$2,$3,$4,'medium','active')`,
      [id[from], id[to], type, crossSector],
    );
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    for (const [t, s] of [["A", "Tech"], ["B", "Tech"], ["C", "Tech"], ["D", "Energy"], ["E", "Tech"], ["F", "Tech"], ["G", "Tech"]] as const) {
      id[t] = await mkCompany(t, s);
    }
    await mkLink("A", "B", "thematic_peer", false);
    await mkLink("A", "D", "supplier", true); // cross-sector
    await mkLink("A", "F", "thematic_peer", false);
    await mkLink("A", "G", "thematic_peer", false);
    await mkLink("B", "C", "thematic_peer", false);
    await mkLink("C", "E", "thematic_peer", false);
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("travels depth-limited + materiality-gated, follows cross-sector, stops at immaterial", async () => {
    const verdict: Record<string, { material: boolean; materiality: "low" | "medium" | "high" }> = {
      B: { material: true, materiality: "high" },
      D: { material: true, materiality: "high" },
      C: { material: true, materiality: "medium" },
      F: { material: false, materiality: "low" },
      G: { material: true, materiality: "low" }, // material but below the flag floor → gated out
    };
    const analyzer = fakeAnalyzer({ score: () => 80, readThrough: (n) => verdict[n] ?? { material: false, materiality: "low" } });

    const out = await propagateReadThrough(analyzer, {
      noteId: randomUUID(), companyId: id.A, companyName: "A",
      headline: "A event", summary: "A summary", category: "guidance", sourceRef: null,
    });

    expect(out.notesCreated).toBe(3);
    expect(new Set(out.reached)).toEqual(new Set([id.B, id.D, id.C]));

    const noted = async (t: string) =>
      Number((await db.pool.query<{ n: string }>("SELECT count(*)::int n FROM news_notes WHERE company_id=$1 AND origin_kind='read_through'", [id[t]])).rows[0].n);

    expect(await noted("B")).toBe(1); // in-sector peer, material
    expect(await noted("D")).toBe(1); // CROSS-sector, followed
    expect(await noted("C")).toBe(1); // depth-2 reach
    expect(await noted("E")).toBe(0); // depth 3 → excluded
    expect(await noted("F")).toBe(0); // immaterial
    expect(await noted("G")).toBe(0); // materiality gate
  });
});
