/**
 * Consumer surface publish-gate (Workstream C review fix). The swipe surface must show the AI thesis
 * ONLY for a latest snapshot with an active 'approved' desk approval — a below-bar/in_review hold or a
 * vetoed snapshot shows identity + a status card only, and never a confidence stamp.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { buildConsumerView } from "../lib/views/consumer";

describe("Consumer publish-gate", () => {
  let db: Ephemeral;
  let seq = 0;

  async function seed(opts: { status: string; approval: "approved" | "vetoed" | "none" }): Promise<string> {
    const tkr = `CN${seq++}`;
    const c = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ($4,$5,$1,$2,$3,$6,'Information Technology','listed') RETURNING id`,
      [{ legal_name: `Corp ${tkr}`, tickers: [tkr] }, {}, { status: opts.status, positions_held: [] }, `Corp ${tkr}`, tkr, opts.status],
    );
    const companyId = c.rows[0].id;
    const cf = await db.pool.query<{ id: string }>("INSERT INTO canonical_files (company_id) VALUES ($1) RETURNING id", [companyId]);
    const content = {
      thesis: { one_liner: "Margin-led compounder", long_form: "Long.", invalidation_triggers: ["Net margin < 22%"] },
      fundamentals: { model: { line_items: { revenue: { label: "Revenue", value: 85e9, unit: "USD", yoy: { change_pct: 0.05 } } } } },
      hypotheses: { drivers: [{ name: "Services", direction: "tailwind", framing: "momentum" }] },
      research: { verification: { confidence: 0.82, recommendation: "auto" } },
    };
    const snapId = randomUUID();
    await db.pool.query(
      "INSERT INTO canonical_snapshots (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, content, diff) VALUES ($1,$2,$3,'2026-03-28','10-Q Q2','manual',4,$4,'{}')",
      [snapId, cf.rows[0].id, companyId, JSON.stringify(content)],
    );
    if (opts.approval !== "none") {
      await db.pool.query("INSERT INTO thesis_approvals (snapshot_id, company_id, approved_by, status) VALUES ($1,$2,'desk',$3)", [snapId, companyId, opts.approval]);
    }
    return companyId;
  }

  beforeAll(async () => { db = await createEphemeralDb(); setPool(db.pool); });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("approved: shows the opinion cards + confidence stamp", async () => {
    const id = await seed({ status: "published", approval: "approved" });
    const v = (await buildConsumerView(id))!;
    expect(v.cards.some((c) => c.kind === "one_liner")).toBe(true);
    expect(v.confidence).toBe(0.82);
    expect(v.vetoed).toBe(false);
  });

  it("in_review hold (no approval): identity + status card only, no opinion, no confidence", async () => {
    const id = await seed({ status: "in_review", approval: "none" });
    const v = (await buildConsumerView(id))!;
    expect(v.cards.map((c) => c.kind)).toEqual(["header", "under_review"]);
    expect(v.cards.some((c) => c.kind === "one_liner")).toBe(false);
    expect(v.confidence).toBeNull();
  });

  it("vetoed: retracted to a status card, no confidence", async () => {
    const id = await seed({ status: "in_review", approval: "vetoed" });
    const v = (await buildConsumerView(id))!;
    expect(v.cards.some((c) => c.kind === "one_liner")).toBe(false);
    expect(v.vetoed).toBe(true);
    expect(v.confidence).toBeNull();
  });
});
