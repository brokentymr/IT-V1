import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fakeAnalyzer, fakeResearchPanel } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { SecAdapter } from "../lib/sources/sec";
import type { JsonFetcher, TextFetcher } from "../lib/sources/types";
import type { FundamentalsAnalyst } from "../lib/engines/fundamentals_analyst";
import type { ResearchPanel } from "../lib/engines/research";
import { mulberry32 } from "../lib/financials/montecarlo";
import { runCoveragePass } from "../lib/engines/fundamental_research";

const CIK = "0000320193";
const ACC = "0000320193-24-000081";

const factsBody = {
  cik: 320193,
  entityName: "APPLE INC",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        units: { USD: [
          { start: "2024-03-31", end: "2024-06-29", val: 85_777_000_000, fy: 2024, fp: "Q3", form: "10-Q", accn: ACC },
          { start: "2023-04-02", end: "2023-07-01", val: 81_797_000_000, fy: 2023, fp: "Q3", form: "10-Q", accn: "old" },
        ] },
      },
      NetIncomeLoss: {
        units: { USD: [
          { start: "2024-03-31", end: "2024-06-29", val: 21_448_000_000, fy: 2024, fp: "Q3", form: "10-Q", accn: ACC },
        ] },
      },
    },
  },
};
const submissionsBody = {
  filings: { recent: {
    accessionNumber: [ACC], form: ["10-Q"], filingDate: ["2024-08-01"],
    reportDate: ["2024-06-29"], primaryDocument: ["aapl-20240629.htm"],
  } },
};
const jsonFetcher: JsonFetcher = async (url) => {
  if (url.includes("companyfacts")) return { status: 200, body: factsBody };
  if (url.includes("submissions")) return { status: 200, body: submissionsBody };
  return { status: 404, body: null };
};
const textFetcher: TextFetcher = async () => ({
  status: 200,
  text: "<h2>Management's Discussion and Analysis of Financial Condition</h2>" +
    "<p>Services growth continued while component costs rose.</p>" +
    "<h2>Quantitative and Qualitative Disclosures About Market Risk</h2>",
});

const analyst: FundamentalsAnalyst = {
  async frameForward() {
    return { expectations: "Services growth carries the quarter", focus_metrics: ["revenue"], confirm_conditions: [], break_conditions: [] };
  },
  async draftThesis() {
    return { one_liner: "Margin-led compounder", long_form: "Long form.", actual_vs_expected: "Beat on revenue.",
      tensions: [], invalidation_triggers: ["draft"], conviction: 4 };
  },
  async extractDrivers() {
    return { drivers: [
      { name: "Services growth", metric: "revenue" as const, direction: "tailwind" as const, framing: "Services momentum", quote: "Services growth continued", impact_pct: { bear: -1, base: 1.5, bull: 4 } },
    ] };
  },
  async extractLinks() { return { links: [] }; },
};

// The desk's synthesized thesis (research panel) carries the invalidation triggers the pipeline
// publishes; override them per test to exercise quarantine.
function panelWith(triggers: string[]): ResearchPanel {
  const base = fakeResearchPanel();
  return {
    ...base,
    async runResearch(input) {
      const r = await base.runResearch(input);
      return { ...r, thesis: { ...r.thesis, invalidation_triggers: triggers } };
    },
  };
}

describe("Provenance — unverified-number quarantine (integration)", () => {
  let db: Ephemeral;
  let companyId: string;
  const sec = new SecAdapter(jsonFetcher, textFetcher);
  const newsAnalyzer = fakeAnalyzer({ score: () => 50, readThrough: () => ({ material: false, materiality: "low" }) });

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, cik, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,$5,'monitoring',$6) RETURNING id`,
      ["AAPL", CIK, { legal_name: "AAPL", tickers: ["AAPL"] },
        { gics_sector: "Information Technology", industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] }, "Information Technology"],
    );
    companyId = rows[0].id;
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("quarantines an ungrounded currency trigger, keeps the grounded one, and persists numeric claims", async () => {
    const r = await runCoveragePass({
      companyId, accession: ACC, formType: "10-Q", filingUrl: "https://sec.gov/x/aapl.htm",
      analyst,
      panel: panelWith(["Revenue drops below $85.8B for two quarters", "Revenue collapses to $2 trillion next quarter", "Net margin < 22% for two quarters"]),
      newsAnalyzer, sec, trigger: "manual", rng: mulberry32(7),
    });

    const snap = await db.pool.query(
      "SELECT snapshot_id, content FROM canonical_snapshots WHERE company_id=$1 AND snapshot_id=$2", [companyId, r.snapshot_id],
    );
    expect(snap.rowCount).toBe(1);
    const content = snap.rows[0].content;
    const snapshotId = snap.rows[0].snapshot_id;

    // The grounded currency figure ($85.8B ≈ XBRL revenue) and the percent bar survive; the out-of-scale
    // $2 trillion figure (fabricated vs a tens-of-billions model) is dropped from the published triggers.
    const triggers: string[] = content.thesis.invalidation_triggers;
    expect(triggers).toContain("Revenue drops below $85.8B for two quarters");
    expect(triggers).toContain("Net margin < 22% for two quarters");
    expect(triggers).not.toContain("Revenue collapses to $2 trillion next quarter");

    // The quarantined trigger is recorded in the provenance audit.
    expect(content.provenance_audit.quarantined_triggers).toEqual(["Revenue collapses to $2 trillion next quarter"]);

    // Verified located claims were persisted (one per line item at least) alongside the snapshot.
    const claims = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM numeric_claims WHERE snapshot_id=$1 AND verified=true AND source_locator LIKE 'xbrl:%'",
      [snapshotId],
    );
    expect(claims.rows[0].n).toBeGreaterThanOrEqual(2); // revenue + net_income

    // A quarantine present -> the snapshot is held for review, never auto-published.
    expect(r.published_status).not.toBe("published");
  });

  it("admits when every currency figure is grounded (no quarantine, clean audit)", async () => {
    const r = await runCoveragePass({
      companyId, accession: ACC, formType: "10-Q", filingUrl: "https://sec.gov/x/aapl.htm",
      analyst, panel: panelWith(["Net margin falls below 20% for two quarters"]),
      newsAnalyzer, sec, trigger: "manual", rng: mulberry32(7),
    });

    const snap = await db.pool.query(
      "SELECT content FROM canonical_snapshots WHERE company_id=$1 AND snapshot_id=$2", [companyId, r.snapshot_id],
    );
    const content = snap.rows[0].content;
    expect(content.provenance_audit).toBeUndefined(); // nothing quarantined -> key omitted
    expect(content.thesis.invalidation_triggers).toContain("Net margin falls below 20% for two quarters");
  });
});
