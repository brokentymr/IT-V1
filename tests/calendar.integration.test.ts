import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { listCalendar } from "../lib/views/calendar";
import { accumulateArea } from "../lib/engines/areas_of_interest";

describe("Calendar read model (Phase 6)", () => {
  let db: Ephemeral;
  let aaplId: string;

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing, next_earnings_date)
       VALUES ('AAPL','AAPL',$1,$2,$3,'monitoring','Information Technology','listed','2026-07-15') RETURNING id`,
      [{ legal_name: "AAPL", tickers: ["AAPL"] }, { gics_sector: "Information Technology" }, { status: "monitoring", positions_held: [] }],
    );
    aaplId = rows[0].id;
    // A staged forward note for that exact date + one open area.
    await db.pool.query(
      "INSERT INTO canonical_files (company_id, current_events) VALUES ($1, $2)",
      [aaplId, JSON.stringify({ forward_note: { next_earnings_date: "2026-07-15" } })],
    );
    await accumulateArea({ companyId: aaplId, category: "product", band: "major", score: 72, headline: "price hike", url: "u", summary: "s" });
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("returns earnings events in range with forward_staged + open-area count", async () => {
    const evs = await listCalendar({ from: "2026-07-01", to: "2026-07-31" });
    expect(evs.length).toBe(1);
    expect(evs[0].ticker).toBe("AAPL");
    expect(evs[0].date).toBe("2026-07-15");
    expect(evs[0].forward_staged).toBe(true);
    expect(evs[0].open_areas).toBe(1);
  });

  it("excludes events outside the window", async () => {
    const evs = await listCalendar({ from: "2026-08-01", to: "2026-08-31" });
    expect(evs.length).toBe(0);
  });
});
