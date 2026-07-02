import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import {
  buildClaimDag, markFactCorrected, retractFact, retractClaim,
  propagateRestatement, snapshotClaimHealth, hasStaleClaims,
} from "../lib/engines/claim_dag";

// A snapshot's content, minimal but exercising the fact kinds + a revenue-referencing thesis.
function contentFor(sourceId: string, revenue: number, period: string) {
  return {
    fundamentals: {
      model: {
        period_end: period,
        fiscal_period: period,
        line_items: {
          revenue: { label: "Revenue", value: revenue, unit: "USD", period_end: period },
          net_income: { label: "Net income", value: 20e9, unit: "USD", period_end: period },
        },
        ratios: { net_margin: 0.25 },
      },
      provenance: [
        { claim_id: "fundamentals.revenue", source_ref: sourceId },
        { claim_id: "fundamentals.net_income", source_ref: sourceId },
      ],
    },
    thesis: {
      one_liner: "Revenue-led compounder with durable margins",
      long_form: "The revenue franchise compounds.",
      tensions: ["Margin pressure from mix"],
      invalidation_triggers: ["Revenue falls two quarters"],
    },
  };
}

describe("claim_dag — build + stale propagation (integration, P4)", () => {
  let db: Ephemeral;
  let companyId: string;
  let sourceId: string;
  let cfId: string;

  beforeAll(async () => { db = await createEphemeralDb(); setPool(db.pool); });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  // A fresh company per test: canonical_snapshots is append-only (cannot be cleaned between tests), so
  // isolating the company keeps propagateRestatement's cross-snapshot comparison scoped to one test.
  beforeEach(async () => {
    const co = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, cik, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,$5,'monitoring',$6) RETURNING id`,
      [`AAA-${randomUUID().slice(0, 8)}`, randomUUID().slice(0, 10), { legal_name: "AAA", tickers: ["AAA"] },
        { gics_sector: "Information Technology", industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] }, "Information Technology"],
    );
    companyId = co.rows[0].id;
    const cf = await db.pool.query<{ id: string }>(
      "INSERT INTO canonical_files (company_id) VALUES ($1) RETURNING id", [companyId],
    );
    cfId = cf.rows[0].id;
    const src = await db.pool.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, retrieved_at) VALUES ($1,1,'filing','SEC EDGAR', now()) RETURNING id`,
      [companyId],
    );
    sourceId = src.rows[0].id;
  });

  async function insertSnapshot(content: unknown, asOf: string): Promise<string> {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO canonical_snapshots
         (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, confidence, filing_ref, content, diff)
       VALUES ($1,$2,$3,$4,$5,'filing',4,0.8,'acc',$6,'{}')`,
      [id, cfId, companyId, asOf, `Filing ${asOf}`, JSON.stringify(content)],
    );
    return id;
  }

  it("builds the DAG (facts, claims, edges) idempotently and reports health", async () => {
    const snap = await insertSnapshot(contentFor(sourceId, 85e9, "2024-06-29"), "2024-08-01");
    const c1 = await buildClaimDag(snap);
    expect(c1.facts).toBeGreaterThanOrEqual(3); // revenue, net_income, ratio.net_margin
    expect(c1.claims).toBeGreaterThanOrEqual(4);
    expect(c1.edges).toBeGreaterThan(0);

    const h = await snapshotClaimHealth(snap);
    expect(h.claims_fresh).toBe(c1.claims);
    expect(h.facts_active).toBe(c1.facts);
    expect(h.claims_stale).toBe(0);

    // fact source_ref is attached from the content provenance
    const f = await db.pool.query<{ source_ref: string }>(
      "SELECT source_ref FROM claim_facts WHERE snapshot_id=$1 AND fact_key='fundamentals.revenue'", [snap],
    );
    expect(f.rows[0].source_ref).toBe(sourceId);

    // Rebuild is idempotent (no duplicate rows, same counts).
    const c2 = await buildClaimDag(snap);
    expect(c2).toEqual(c1);
    const n = await db.pool.query<{ n: number }>("SELECT count(*)::int n FROM claim_facts WHERE snapshot_id=$1", [snap]);
    expect(n.rows[0].n).toBe(c1.facts);
  });

  it("markFactCorrected stales every claim consuming the fact", async () => {
    const snap = await insertSnapshot(contentFor(sourceId, 85e9, "2024-06-29"), "2024-08-01");
    await buildClaimDag(snap);

    const staled = await markFactCorrected({ snapshotId: snap, factKey: "fundamentals.revenue", reason: "typo" });
    expect(staled).toBeGreaterThan(0);
    expect(await hasStaleClaims(snap)).toBe(true);

    const h = await snapshotClaimHealth(snap);
    expect(h.facts_corrected).toBe(1);
    expect(h.claims_stale).toBe(staled);
  });

  it("retractFact retracts the fact and stales its claims; retractClaim retracts one claim", async () => {
    const snap = await insertSnapshot(contentFor(sourceId, 85e9, "2024-06-29"), "2024-08-01");
    await buildClaimDag(snap);

    const staled = await retractFact({ snapshotId: snap, factKey: "fundamentals.revenue", reason: "hard identity fail" });
    expect(staled).toBeGreaterThan(0);
    const h = await snapshotClaimHealth(snap);
    expect(h.facts_retracted).toBe(1);

    // Retract a single fresh claim.
    const one = await db.pool.query<{ id: string }>(
      "SELECT id FROM claims WHERE snapshot_id=$1 AND status='fresh' LIMIT 1", [snap],
    );
    if (one.rows[0]) {
      expect(await retractClaim(one.rows[0].id, "operator veto")).toBe(true);
      const r = await db.pool.query<{ status: string }>("SELECT status FROM claims WHERE id=$1", [one.rows[0].id]);
      expect(r.rows[0].status).toBe("retracted");
    }
  });

  it("propagateRestatement flags a same-period divergence but NOT a routine next-period filing", async () => {
    // Prior snapshot: revenue 85B for Q ending 2024-06-29.
    const prior = await insertSnapshot(contentFor(sourceId, 85e9, "2024-06-29"), "2024-08-01");
    await buildClaimDag(prior);

    // A restatement for the SAME period with a >10% lower revenue.
    const restated = await insertSnapshot(contentFor(sourceId, 70e9, "2024-06-29"), "2024-09-01");
    await buildClaimDag(restated);

    const staled = await propagateRestatement(companyId, restated);
    expect(staled).toBeGreaterThan(0);
    // The PRIOR snapshot's revenue fact is now corrected and its claims stale.
    const pf = await db.pool.query<{ status: string }>(
      "SELECT status FROM claim_facts WHERE snapshot_id=$1 AND fact_key='fundamentals.revenue'", [prior],
    );
    expect(pf.rows[0].status).toBe("corrected");
    expect(await hasStaleClaims(prior)).toBe(true);
  });

  it("propagateRestatement does NOT flag a routine next-period filing", async () => {
    const prior = await insertSnapshot(contentFor(sourceId, 85e9, "2024-06-29"), "2024-08-01");
    await buildClaimDag(prior);

    // Next period (different period_end), revenue naturally changed a lot — must NOT be a restatement.
    const next = await insertSnapshot(contentFor(sourceId, 60e9, "2024-09-28"), "2024-11-01");
    await buildClaimDag(next);

    const staled = await propagateRestatement(companyId, next);
    expect(staled).toBe(0);
    const pf = await db.pool.query<{ status: string }>(
      "SELECT status FROM claim_facts WHERE snapshot_id=$1 AND fact_key='fundamentals.revenue'", [prior],
    );
    expect(pf.rows[0].status).toBe("active");
    expect(await hasStaleClaims(prior)).toBe(false);
  });
});
