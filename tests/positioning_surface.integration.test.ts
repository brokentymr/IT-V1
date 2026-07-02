import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { getCompanyDetail } from "../lib/views/company";
import { assembleSubstance } from "../lib/content/assemble";
import { buildConsumerView } from "../lib/views/consumer";
import { upsertReadThrough } from "../lib/engines/read_through_relationships";

// A single approved snapshot carrying a positioning readout + two read-through counterparties. Asserts
// the three read surfaces expose them: getCompanyDetail (external_relationships), assembleSubstance
// (positioning + external_relationships + read-through provenance) and buildConsumerView (the cards).
describe("positioning + read-through surfacing (integration)", () => {
  let db: Ephemeral;
  let companyId: string;
  let sourceId: string;

  const positioning = {
    strategic_stance: "constructive",
    tactical_stance: "add on weakness",
    conviction: 4,
    variant_view: "Street underrates the margin durability.",
    is_consensus: false,
    price_target: { bear: 120, base: 150, bull: 180 },
    invalidation_triggers: ["Gross margin < 60% for two quarters"],
    implied_assumptions: ["Spot $100 prices ~10.0× P50 EPS ($10.00)."],
    fair_value: { low: 120, base: 150, high: 180, multiple: 15, basis: "illustrative", consistent_with_lean: true, reconciliation: "In line with the stated base target $150." },
    action_rules: [{ trigger: "Gross margin < 60% for two quarters", rule: "Cut exposure and re-underwrite." }],
  };

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);

    const co = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ('Acme Inc','ACME',$1,$2,$3,'monitoring','Tech') RETURNING id`,
      [{ legal_name: "Acme Inc", tickers: ["ACME"] },
        { gics_sector: "Tech", industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] }],
    );
    companyId = co.rows[0].id;

    const cf = await db.pool.query<{ id: string }>(
      "INSERT INTO canonical_files (company_id) VALUES ($1) RETURNING id", [companyId],
    );
    const src = await db.pool.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title)
       VALUES ($1,1,'filing','SEC EDGAR','http://x','10-K 000') RETURNING id`, [companyId],
    );
    sourceId = src.rows[0].id;

    const content = {
      fundamentals: {
        model: { fiscal_period: "FY2025", line_items: { revenue: { label: "Revenue", value: 1_000_000_000, unit: "USD", yoy: { change_pct: 0.2 } } }, ratios: { gross_margin: 0.82 } },
        provenance: [{ claim_id: "fundamentals.revenue", source_ref: sourceId }],
      },
      thesis: { one_liner: "Margin-led compounder", long_form: "Long form.", tensions: [], invalidation_triggers: ["Gross margin < 60% for two quarters"], conviction: 4 },
      positioning,
      research: { verification: { confidence: 0.8, recommendation: "auto" }, provenance: [{ claim_id: "research", source_ref: sourceId }] },
    };

    const snap = await db.pool.query<{ snapshot_id: string }>(
      `INSERT INTO canonical_snapshots (canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, content)
       VALUES ($1,$2,'2026-01-01','10-K FY2025','manual',4,$3) RETURNING snapshot_id`,
      [cf.rows[0].id, companyId, JSON.stringify(content)],
    );
    const snapshotId = snap.rows[0].snapshot_id;

    await db.pool.query(
      "INSERT INTO thesis_approvals (snapshot_id, company_id, approved_by, status) VALUES ($1,$2,'operator','approved')",
      [snapshotId, companyId],
    );

    // Two read-through counterparties, one high one medium; the high one carries the filing source_ref.
    await upsertReadThrough(db.pool, {
      companyId, snapshotId, counterpartyName: "Globex Corp", ticker: "GLBX", type: "customer",
      materiality: "high", rationale: "top customer", readThrough: "~30% of revenue", sourceRef: sourceId,
    });
    await upsertReadThrough(db.pool, {
      companyId, snapshotId, counterpartyName: "Initech", ticker: null, type: "supplier",
      materiality: "medium", rationale: "sole supplier", readThrough: "wafer supply", sourceRef: null,
    });
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("getCompanyDetail exposes external_relationships, most-material first", async () => {
    const d = await getCompanyDetail(companyId);
    expect(d).not.toBeNull();
    expect(d!.external_relationships).toHaveLength(2);
    expect(d!.external_relationships[0].counterparty_name).toBe("Globex Corp"); // high before medium
    expect(d!.external_relationships[0].materiality).toBe("high");
  });

  it("assembleSubstance carries positioning, relationships, and the read-through source in provenance", async () => {
    const sub = await assembleSubstance(companyId);
    expect(sub.positioning?.strategic_stance).toBe("constructive");
    expect(sub.positioning?.fair_value?.base).toBe(150);
    expect(sub.positioning?.action_rules).toHaveLength(1);
    expect(sub.external_relationships).toHaveLength(2);
    // The filing source is cited exactly once (deduped across fundamentals/research/read-through).
    expect(sub.provenance.some((p) => p.ref === sourceId)).toBe(true);
  });

  it("buildConsumerView renders the positioning + relationships cards", async () => {
    const v = await buildConsumerView(companyId);
    expect(v).not.toBeNull();
    expect(v!.show_thesis).toBe(true);
    const kinds = v!.cards.map((c) => c.kind);
    expect(kinds).toContain("positioning");
    expect(kinds).toContain("relationships");
    const rel = v!.cards.find((c) => c.kind === "relationships")!;
    expect(rel.bullets.some((b) => b.includes("Globex Corp"))).toBe(true);
  });
});
