import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { upsertReadThrough, linkReadThroughMatch, loadReadThrough } from "../lib/engines/read_through_relationships";

describe("read_through_relationships store (integration)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};

  async function mkCompany(ticker: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,'monitoring','Tech') RETURNING id`,
      [ticker, { legal_name: ticker, tickers: [ticker] },
        { gics_sector: "Tech", industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] }],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.A = await mkCompany("A");
    id.B = await mkCompany("B"); // becomes covered later
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("upserts, de-dupes on (company, name, type), and latest wins", async () => {
    const n1 = await upsertReadThrough(db.pool, {
      companyId: id.A, snapshotId: null, counterpartyName: "Acme Corp", ticker: "ACME",
      type: "customer", materiality: "medium", rationale: "named customer", readThrough: "20% of revenue",
    });
    expect(n1).toBe(1);

    // Same counterparty + type → UPDATE (latest materiality/read_through wins), still one row.
    const n2 = await upsertReadThrough(db.pool, {
      companyId: id.A, snapshotId: null, counterpartyName: "acme corp", // different casing
      type: "customer", materiality: "high", rationale: "grew to top customer", readThrough: "35% of revenue",
    });
    expect(n2).toBe(1);

    // Different TYPE for the same name → a separate edge.
    await upsertReadThrough(db.pool, {
      companyId: id.A, snapshotId: null, counterpartyName: "Acme Corp",
      type: "supplier", materiality: "low", rationale: "also supplies us", readThrough: "wafer supply",
    });

    const rows = await loadReadThrough(id.A);
    const customer = rows.find((r) => r.type === "customer")!;
    expect(customer.materiality).toBe("high"); // updated
    expect(customer.read_through).toBe("35% of revenue");
    expect(customer.ticker).toBe("ACME"); // preserved by COALESCE when the update omitted it
    expect(rows.filter((r) => r.counterparty_name.toLowerCase() === "acme corp")).toHaveLength(2);
    // Ordered most-material first.
    expect(rows[0].materiality).toBe("high");
  });

  it("links an uncovered edge to a company once it becomes covered", async () => {
    await upsertReadThrough(db.pool, {
      companyId: id.A, snapshotId: null, counterpartyName: "B", type: "customer",
      materiality: "medium", rationale: "named", readThrough: "buys our chips",
    });
    let rows = await loadReadThrough(id.A);
    expect(rows.find((r) => r.counterparty_name === "B")!.to_company_id).toBeNull();

    const updated = await linkReadThroughMatch(db.pool, id.A, "B", id.B);
    expect(updated).toBe(1);
    rows = await loadReadThrough(id.A);
    const edge = rows.find((r) => r.counterparty_name === "B")!;
    expect(edge.to_company_id).toBe(id.B);
    expect(edge.to_name).toBe("B");
  });

  it("cascades on company delete", async () => {
    await db.pool.query("DELETE FROM companies WHERE id = $1", [id.A]);
    const { rows } = await db.pool.query<{ n: string }>(
      "SELECT count(*)::int n FROM read_through_relationships WHERE company_id = $1", [id.A],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});
