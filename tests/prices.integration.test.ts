import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { PriceAdapter, parseYahooChart, latestReturn, dailyVol } from "../lib/sources/prices";
import type { JsonFetcher } from "../lib/sources/types";
import { runPriceMonitor } from "../lib/engines/price_monitor";
import type { PriceAttributor, PriceAttributionInput } from "../lib/engines/price_attribution";
import { accumulateArea, loadOpenAreas } from "../lib/engines/areas_of_interest";

// A Yahoo chart payload from a close series (one bar per day starting 2026-06-01 UTC).
const chart = (closes: number[]) => ({
  chart: {
    result: [{
      timestamp: closes.map((_, i) => Math.floor(Date.UTC(2026, 5, 1 + i) / 1000)),
      indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) }] },
    }],
  },
});

// AAPL ends -6% (102 → 95.88); SPY ~flat (+0.2%); BBB calm (+0.5%).
const SERIES: Record<string, number[]> = {
  AAPL: [100, 101, 100, 102, 95.88],
  SPY: [400, 401, 400, 402, 402.8],
  BBB: [50, 50.2, 50.1, 50.3, 50.55],
};
const fetcher: JsonFetcher = async (url) => {
  const sym = decodeURIComponent(url.match(/chart\/([^?]+)/)?.[1] ?? "");
  return SERIES[sym] ? { status: 200, body: chart(SERIES[sym]) } : { status: 404, body: null };
};

describe("Price-anomaly monitor (Phase 6)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};
  const seen: PriceAttributionInput[] = [];

  const attributor: PriceAttributor = {
    async attribute(input) {
      seen.push(input);
      return { explanation: `${input.company.ticker} moved on macro`, primary_driver: "macro", verdict: "overreaction", note: "street overreacted" };
    },
  };

  async function mk(ticker: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ($1,$1,$2,$3,$4,'monitoring','Information Technology','listed') RETURNING id`,
      [ticker, { legal_name: ticker, tickers: [ticker] }, { gics_sector: "Information Technology" }, { status: "monitoring", positions_held: [] }],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.AAPL = await mk("AAPL");
    id.BBB = await mk("BBB");
    // A coincident news area on AAPL — the fusion: the move should be linked to it.
    await accumulateArea({ companyId: id.AAPL, category: "product", band: "major", score: 72, headline: "Apple raises product prices", url: "u1", summary: "prices up" });
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("parses the Yahoo chart and computes the latest return + vol", () => {
    const bars = parseYahooChart(chart(SERIES.AAPL));
    expect(bars.length).toBe(5);
    const lr = latestReturn(bars)!;
    expect(lr.ret).toBeCloseTo(-0.06, 3);
    expect(dailyVol(bars)).toBeGreaterThan(0);
  });

  it("degrades on a missing symbol (no throw)", async () => {
    const res = await new PriceAdapter(fetcher).dailyBars("NOPE", {});
    expect(res.ok).toBe(false);
    expect(res.data).toBeNull();
  });

  it("opens + attributes + resolves a price_action area on an abnormal move; passes coincident areas", async () => {
    const r = await runPriceMonitor({ prices: new PriceAdapter(fetcher), attributor, companyIds: [id.AAPL, id.BBB] });
    expect(r.companies).toBe(2);
    expect(r.anomalies).toBe(1);          // only AAPL breached 4%
    expect(r.areas_opened).toBe(1);
    expect(r.resolved).toBe(1);           // attributor verdict 'overreaction' resolves it

    const aaplSeen = seen.find((s) => s.company.ticker === "AAPL")!;
    expect(aaplSeen.move.idiosyncratic_pct).not.toBeNull();                 // benchmark split computed
    expect(aaplSeen.coincident_areas.some((a) => a.includes("product"))).toBe(true); // fused with the news area

    // price_action area is now resolved (overreaction); the product news area stays open.
    const open = await loadOpenAreas(id.AAPL);
    expect(open.some((a) => a.theme === "price_action")).toBe(false);
    expect(open.some((a) => a.theme === "product")).toBe(true);
    const pa = await db.pool.query("SELECT disposition, summary FROM areas_of_interest WHERE company_id=$1 AND theme='price_action'", [id.AAPL]);
    expect(pa.rows[0].disposition).toBe("overreaction");
    expect(pa.rows[0].summary).toContain("macro");                          // attribution explanation stored

    // BBB had no anomaly → no price_action area
    expect((await loadOpenAreas(id.BBB)).length).toBe(0);
  });
});
