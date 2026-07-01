import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { runOnboarding, latestOnboarding, type OnboardRunners } from "../lib/engines/onboarding";

const ok: OnboardRunners = {
  coverage: async () => "10-Q ok",
  monitor: async () => "3 notes",
  sentiment: async () => "gap aligned",
  price: async () => "0 anomalies",
  profile: async () => "profile built",
};

describe("Auto-on-add onboarding (level-up B)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};

  async function mk(ticker: string, listing: string, cik: string | null): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, cik, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ($1,$1,$2,$3,$4,$5,'watchlist','Information Technology',$6) RETURNING id`,
      [ticker, cik, { legal_name: ticker, tickers: [ticker] }, { gics_sector: "Information Technology" }, { status: "watchlist", positions_held: [] }, listing],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.LISTED = await mk("LST", "listed", "0000000001");
    id.PRIV = await mk("PRV", "private", null);
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("runs the full listed chain, records steps, and lands at 'Ready for your review'", async () => {
    const r = await runOnboarding({ companyId: id.LISTED, runners: ok });
    expect(r.status).toBe("done");
    expect(r.steps.map((s) => s.step)).toEqual(["fundamentals", "news", "sentiment", "price"]);
    expect(r.steps.every((s) => s.status === "ok")).toBe(true);

    const c = await db.pool.query("SELECT coverage_status FROM companies WHERE id=$1", [id.LISTED]);
    expect(c.rows[0].coverage_status).toBe("in_review"); // ready for review (the §8 checkpoint is next)
    const run = await latestOnboarding(id.LISTED);
    expect(run?.status).toBe("done");
  });

  it("degrades: a failing step is recorded but the run continues", async () => {
    const runners: OnboardRunners = { ...ok, sentiment: async () => { throw new Error("StockTwits 429"); } };
    const r = await runOnboarding({ companyId: id.LISTED, runners });
    expect(r.status).toBe("done"); // other steps ok
    const sent = r.steps.find((s) => s.step === "sentiment")!;
    expect(sent.status).toBe("failed");
    expect(sent.detail).toContain("429");
    expect(r.steps.filter((s) => s.status === "ok").length).toBe(3);
  });

  it("an unlisted name runs the profile path and skips fundamentals", async () => {
    const r = await runOnboarding({ companyId: id.PRIV, runners: ok });
    expect(r.steps.map((s) => `${s.step}:${s.status}`)).toEqual(["profile:ok", "fundamentals:skipped"]);
    const c = await db.pool.query("SELECT coverage_status FROM companies WHERE id=$1", [id.PRIV]);
    expect(c.rows[0].coverage_status).toBe("in_review");
  });
});
