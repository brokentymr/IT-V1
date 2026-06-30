import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { PerplexityClient, PerplexityFinance, type PerplexityFetcher } from "../lib/sources/perplexity";

// A fake Sonar endpoint: routes by the user question, returns content WITH citation markers and a
// per-request cost (mirrors the real API's usage.cost.total_cost).
const fakeFetcher: PerplexityFetcher = async (body) => {
  const msgs = (body as { messages: Array<{ content: string }> }).messages;
  const q = msgs[msgs.length - 1].content;
  let content = "{}";
  if (/earnings date/i.test(q)) content = "Apple's next earnings date is estimated to be 2026-07-30[1][2] based on historical trends.";
  else if (/fair value/i.test(q)) content = '{"fair_value_usd": 210, "price_target_usd": 225, "rating": "buy", "economic_moat": "wide", "summary": "Wide-moat franchise[1]"}';
  else if (/consensus/i.test(q)) content = '{"period": "Q3 2026", "revenue_estimate_usd": 94000000000, "eps_estimate": 1.42, "last_result": "beat by 3%[1]", "summary": "Services-led growth[2]"}';
  return {
    status: 200,
    body: { choices: [{ message: { content } }], citations: ["https://example.com/aapl"], usage: { prompt_tokens: 10, completion_tokens: 5, cost: { total_cost: 0.005 } } },
  };
};

describe("Perplexity finance adapter (integration)", () => {
  let db: Ephemeral;
  beforeAll(async () => { db = await createEphemeralDb(); setPool(db.pool); });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  const finance = new PerplexityFinance(new PerplexityClient(fakeFetcher));

  it("parses an earnings date (citation markers stripped) and stamps cost to llm_usage", async () => {
    const r = await finance.nextEarningsDate("AAPL", "2026-06-30");
    expect(r.ok).toBe(true);
    expect(r.data).toBe("2026-07-30");
    expect(r.provenance?.origin).toBe("Perplexity (Fiscal.ai)");
    const usage = await db.pool.query<{ cost_usd: string; model: string }>("SELECT cost_usd, model FROM llm_usage ORDER BY ts DESC LIMIT 1");
    expect(usage.rows[0].model).toBe("perplexity:sonar");
    expect(Number(usage.rows[0].cost_usd)).toBeCloseTo(0.005, 6);
  });

  it("parses consensus and analyst view", async () => {
    const c = await finance.consensus("AAPL");
    expect(c.ok).toBe(true);
    expect(c.data?.revenue_estimate_usd).toBe(94_000_000_000);
    expect(c.data?.eps_estimate).toBe(1.42);
    const a = await finance.analystView("AAPL");
    expect(a.ok).toBe(true);
    expect(a.data?.economic_moat).toBe("wide");
    expect(a.data?.fair_value_usd).toBe(210);
  });

  it("degrades (ok=false) on a non-200 without throwing", async () => {
    const erroring = new PerplexityFinance(new PerplexityClient(async () => ({ status: 503, body: null })));
    const r = await erroring.consensus("AAPL");
    expect(r.ok).toBe(false);
    expect(r.data).toBe(null);
    expect(r.missing[0]).toContain("503");
  });
});
