import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { SecAdapter } from "../lib/sources/sec";
import type { JsonFetcher } from "../lib/sources/types";
import type { FundamentalsAnalyst } from "../lib/engines/fundamentals_analyst";
import { runForwardScheduler } from "../lib/engines/scheduler";

const CIK = "0000320193";
const ACC = "0000320193-24-000081";

// Latest 10-Q reported 2024-06-29 → cadence next earnings = +91d = 2024-09-28.
const submissionsBody = {
  filings: { recent: { accessionNumber: [ACC], form: ["10-Q"], filingDate: ["2024-08-01"], reportDate: ["2024-06-29"], primaryDocument: ["x.htm"] } },
};
const factsBody = {
  cik: 320193, entityName: "APPLE INC",
  facts: { "us-gaap": { RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
    { start: "2024-03-31", end: "2024-06-29", val: 85_777_000_000, fy: 2024, fp: "Q3", form: "10-Q", accn: ACC },
  ] } } } },
};
const jsonFetcher: JsonFetcher = async (url) => {
  if (url.includes("companyfacts")) return { status: 200, body: factsBody };
  if (url.includes("submissions")) return { status: 200, body: submissionsBody };
  return { status: 404, body: null };
};

const analyst: FundamentalsAnalyst = {
  async frameForward() {
    return { expectations: "Services growth", focus_metrics: ["revenue"], confirm_conditions: ["Revenue > $84B"], break_conditions: ["Revenue < $80B"] };
  },
  async draftThesis() { return { one_liner: "x", long_form: "x", actual_vs_expected: "", tensions: [], invalidation_triggers: ["x"], conviction: 3 }; },
  async extractDrivers() { return { drivers: [] }; },
  async extractLinks() { return { links: [] }; },
};

describe("Forward-pass scheduler (Phase 6)", () => {
  let db: Ephemeral;
  let aaplId: string;
  const sec = new SecAdapter(jsonFetcher);

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, cik, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ('AAPL','AAPL',$1,$2,$3,$4,'monitoring','Information Technology','listed') RETURNING id`,
      [CIK, { legal_name: "AAPL", tickers: ["AAPL"] }, { gics_sector: "Information Technology" }, { status: "monitoring", positions_held: [] }],
    );
    aaplId = rows[0].id;
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("stages a forward pass for a name inside the T-minus window", async () => {
    const r = await runForwardScheduler({ analyst, sec, today: "2024-09-25" }); // 3 days before 2024-09-28
    expect(r.companies).toBe(1);
    expect(r.staged).toBe(1);
    const cf = await db.pool.query<{ ce: { forward_note?: { next_earnings_date?: string } } }>(
      "SELECT current_events AS ce FROM canonical_files WHERE company_id=$1", [aaplId],
    );
    expect(cf.rows[0].ce.forward_note?.next_earnings_date).toBe("2024-09-28");
  });

  it("does not re-stage the same date (no-duplicate guard)", async () => {
    const r = await runForwardScheduler({ analyst, sec, today: "2024-09-25" });
    expect(r.staged).toBe(0);
    expect(r.skipped_existing).toBe(1);
  });

  it("re-stages when the earnings date has moved", async () => {
    // Simulate the staged date going stale (a moved date no longer matches the resolved date).
    await db.pool.query(
      "UPDATE canonical_files SET current_events = jsonb_set(current_events,'{forward_note,next_earnings_date}','\"2024-06-30\"') WHERE company_id=$1",
      [aaplId],
    );
    const r = await runForwardScheduler({ analyst, sec, today: "2024-09-25" });
    expect(r.staged).toBe(1); // resolved 2024-09-28 != stale 2024-06-30 → re-stage
  });

  it("skips names outside the window", async () => {
    const r = await runForwardScheduler({ analyst, sec, today: "2024-01-01" }); // far from 2024-09-28
    expect(r.staged).toBe(0);
    expect(r.out_of_window).toBe(1);
  });
});
