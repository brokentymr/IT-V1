import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fakeAnalyzer, fakeResearchPanel } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { SecAdapter } from "../lib/sources/sec";
import type { JsonFetcher, TextFetcher } from "../lib/sources/types";
import type { FundamentalsAnalyst } from "../lib/engines/fundamentals_analyst";
import { PerplexityClient, PerplexityFinance, type PerplexityFetcher } from "../lib/sources/perplexity";
import { mulberry32 } from "../lib/financials/montecarlo";
import { runCoveragePass, runForwardPass } from "../lib/engines/fundamental_research";
import { accumulateArea, loadOpenAreas } from "../lib/engines/areas_of_interest";

const AAPL_CIK = "0000320193";
const ACC = "0000320193-24-000081";

// XBRL company facts (Q3'24 vs Q3'23), reported by accession ACC.
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
    "<p>Our largest customer, Dell Technologies, accounted for a substantial portion of net sales. " +
    "Services growth continued while component costs rose.</p>" +
    "<h2>Quantitative and Qualitative Disclosures About Market Risk</h2>",
});

// Fake LLM analyst: deterministic forward frame, thesis (with a specific invalidation trigger),
// and a named-link extraction pointing at Dell.
const analyst: FundamentalsAnalyst = {
  async frameForward() {
    return { expectations: "Services growth carries the quarter", focus_metrics: ["revenue", "net_income"],
      confirm_conditions: ["Revenue > $84B"], break_conditions: ["Revenue < $80B for two quarters"] };
  },
  async draftThesis() {
    return { one_liner: "Margin-led compounder", long_form: "Long form.", actual_vs_expected: "Beat on revenue.",
      tensions: ["China demand"], invalidation_triggers: ["Net income margin falls below 20% for two quarters"], conviction: 4 };
  },
  async extractDrivers() {
    return { drivers: [
      { name: "Services growth", metric: "revenue" as const, direction: "tailwind" as const, framing: "Services momentum", quote: "Services growth continued", impact_pct: { bear: -1, base: 1.5, bull: 4 } },
      { name: "Component costs", metric: "gross_margin" as const, direction: "headwind" as const, framing: "Input cost pressure", quote: "component costs rose", impact_pct: { bear: -3, base: -1, bull: 0 } },
    ] };
  },
  async extractLinks() {
    return { links: [{ name: "Dell Technologies", ticker: "DELL", type: "customer", materiality: "medium", rationale: "named customer" }] };
  },
};

describe("Fundamental Research — coverage + forward (integration)", () => {
  let db: Ephemeral;
  const id: Record<string, string> = {};
  const sec = new SecAdapter(jsonFetcher, textFetcher);

  async function mkCompany(ticker: string, sector: string, cik: string | null): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, cik, identifiers, classification, coverage, coverage_status, gics_sector)
       VALUES ($1,$1,$2,$3,$4,$5,'monitoring',$6) RETURNING id`,
      [ticker, cik, { legal_name: ticker, tickers: [ticker] },
        { gics_sector: sector, industry_group: null, industry: null, sub_industry: null },
        { status: "monitoring", authors: [], positions_held: [] }, sector],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await createEphemeralDb();
    setPool(db.pool);
    id.AAPL = await mkCompany("AAPL", "Information Technology", AAPL_CIK);
    id.HPQ = await mkCompany("HPQ", "Information Technology", "0000047217");
    id.DELL = await mkCompany("DELL", "Information Technology", "0001571996");
    // Pre-existing link AAPL→HPQ for read-through; AAPL→DELL is created by link enrichment.
    await db.pool.query(
      `INSERT INTO company_links (from_company_id,to_company_id,type,cross_sector,strength,status)
       VALUES ($1,$2,'customer',false,'medium','active')`, [id.AAPL, id.HPQ],
    );
  });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  const newsAnalyzer = fakeAnalyzer({
    score: () => 80,
    readThrough: (n) => (n === "HPQ" ? { material: true, materiality: "high" } : { material: false, materiality: "low" }),
  });

  // Fake Perplexity: consensus + analyst view (advisory market context).
  const fakePplx: PerplexityFetcher = async (body) => {
    const q = (body as { messages: Array<{ content: string }> }).messages.slice(-1)[0].content;
    const content = /fair value/i.test(q)
      ? '{"fair_value_usd":210,"price_target_usd":225,"rating":"buy","economic_moat":"wide","summary":"ok"}'
      : '{"period":"Q3 2026","revenue_estimate_usd":94000000000,"eps_estimate":1.42,"last_result":"beat","summary":"ok"}';
    return { status: 200, body: { choices: [{ message: { content } }], citations: ["https://ex.com/aapl"], usage: { cost: { total_cost: 0.004 } } } };
  };
  const finance = new PerplexityFinance(new PerplexityClient(fakePplx));

  it("extracts a grounded snapshot with thesis + diff, enriches links, and reads through", async () => {
    const r = await runCoveragePass({
      companyId: id.AAPL, accession: ACC, formType: "10-Q", filingUrl: "https://sec.gov/x/aapl-20240629.htm",
      analyst, panel: fakeResearchPanel(), newsAnalyzer, finance, sec, trigger: "manual", rng: mulberry32(42),
    });

    expect(r.metrics_extracted).toBe(2);            // revenue + net_income
    expect(r.drivers_extracted).toBe(2);            // MD&A drivers (#3)
    expect(r.scenario).not.toBeNull();              // Monte Carlo scenario (#4)
    expect(r.confidence).toBeGreaterThan(0);        // adversarial verification confidence
    expect(r.needs_review).toBe(false);             // recommendation 'auto' from the fake panel
    expect(r.conviction).toBe(4);
    expect(r.links_enriched).toBe(1);               // AAPL→DELL created from filing text
    expect(r.read_through_notes).toBe(1);           // HPQ only (DELL gated immaterial)

    const snap = await db.pool.query(
      "SELECT cycle_label, trigger, conviction, confidence, filing_ref, content, diff FROM canonical_snapshots WHERE company_id=$1",
      [id.AAPL],
    );
    expect(snap.rowCount).toBe(1);
    const row = snap.rows[0];
    expect(row.filing_ref).toBe(ACC);
    expect(row.trigger).toBe("manual");
    expect(row.content.thesis.one_liner).toBe("Margin-led compounder");
    expect(row.content.thesis.invalidation_triggers.length).toBeGreaterThan(0);
    expect(row.content.fundamentals.model.line_items.revenue.value).toBe(85_777_000_000);
    // every line item carries provenance to a source row
    expect(row.content.fundamentals.provenance.length).toBe(2);
    // advisory market context (Perplexity) is stored, distinct from XBRL, with its own provenance
    expect(row.content.market_context.consensus.revenue_estimate_usd).toBe(94_000_000_000);
    expect(row.content.market_context.analyst_view.economic_moat).toBe("wide");
    expect(row.content.market_context.provenance[0].source_ref).toBeTruthy();
    // analyst desk: 4 expert lenses + adversarial verification stored, confidence promoted
    expect(row.content.research.panel.length).toBe(4);
    expect(row.content.research.verification.recommendation).toBe("auto");
    expect(Number(row.confidence)).toBeGreaterThan(0);
    // MD&A hypotheses (#3) + Monte Carlo scenario (#4) stored on the snapshot
    expect(row.content.hypotheses.drivers.length).toBe(2);
    expect(row.content.hypotheses.provenance[0].source_ref).toBeTruthy();
    const sc = row.content.scenario;
    expect(sc.bands.revenue.p10).toBeLessThan(sc.bands.revenue.p50);
    expect(sc.bands.revenue.p50).toBeLessThan(sc.bands.revenue.p90);
    expect(sc.beat_probability.revenue).toBeGreaterThanOrEqual(0);
    expect(sc.beat_probability.revenue).toBeLessThanOrEqual(1);
    expect(sc.watch_items.length).toBeGreaterThan(0);
    expect(sc.sensitivity.length).toBe(2);
    // Control P5: per-filing-type disclosure coverage scorecard is stamped; Apple fixture has revenue
    // present and no RPO/backlog text → no critical gap → ok=true (keeps committed/needs_review unchanged).
    expect(row.content.coverage_scorecard).toBeTruthy();
    expect(row.content.coverage_scorecard.ok).toBe(true);
    expect(row.content.coverage_scorecard.covered).toContain("revenue");
    // first snapshot has no prior → diff metrics are "new"
    expect(row.diff.metrics.find((m: { key: string }) => m.key === "revenue").direction).toBe("new");

    const dellLink = await db.pool.query(
      "SELECT count(*)::int n FROM company_links WHERE from_company_id=$1 AND to_company_id=$2", [id.AAPL, id.DELL],
    );
    expect(dellLink.rows[0].n).toBe(1);
    const hpqNote = await db.pool.query(
      "SELECT count(*)::int n FROM news_notes WHERE company_id=$1 AND origin_kind='read_through'", [id.HPQ],
    );
    expect(hpqNote.rows[0].n).toBe(1);
  });

  it("is append-only: a re-run appends a second snapshot and the first is untouched", async () => {
    const before = await db.pool.query(
      "SELECT snapshot_id, content, created_at FROM canonical_snapshots WHERE company_id=$1 ORDER BY created_at ASC",
      [id.AAPL],
    );
    expect(before.rowCount).toBe(1);
    const firstId = before.rows[0].snapshot_id;
    const firstContent = JSON.stringify(before.rows[0].content);

    const r2 = await runCoveragePass({
      companyId: id.AAPL, accession: ACC, formType: "10-Q", filingUrl: "https://sec.gov/x/aapl-20240629.htm",
      analyst, panel: fakeResearchPanel(), newsAnalyzer, sec, trigger: "manual",
    });

    const after = await db.pool.query(
      "SELECT snapshot_id, content, diff FROM canonical_snapshots WHERE company_id=$1 ORDER BY created_at ASC",
      [id.AAPL],
    );
    expect(after.rowCount).toBe(2);
    // first snapshot byte-identical (append-only, never mutated)
    const stillFirst = after.rows.find((x) => x.snapshot_id === firstId)!;
    expect(JSON.stringify(stillFirst.content)).toBe(firstContent);
    // second snapshot's diff is computed against the first snapshot's model → revenue flat
    const second = after.rows.find((x) => x.snapshot_id === r2.snapshot_id)!;
    expect(second.diff.metrics.find((m: { key: string }) => m.key === "revenue").direction).toBe("flat");
  });

  it("the coverage pass adjudicates open areas of interest: resolves the addressed one", async () => {
    // Two between-filing areas accumulated from the headlines.
    await accumulateArea({ companyId: id.AAPL, category: "product", band: "major", score: 78, headline: "Device price increase rattles the street", url: "u1", summary: "prices up" });
    await accumulateArea({ companyId: id.AAPL, category: "management", band: "material", score: 60, headline: "Incoming CEO named", url: "u2", summary: "leadership change" });
    expect((await loadOpenAreas(id.AAPL)).length).toBe(2);

    const r = await runCoveragePass({
      companyId: id.AAPL, accession: ACC, formType: "10-Q", filingUrl: "https://sec.gov/x/aapl-20240629.htm",
      analyst, panel: fakeResearchPanel({ areaVerdict: (theme) => (theme === "product" ? "overreaction" : "carry_forward") }),
      newsAnalyzer, sec, trigger: "manual",
    });
    expect(r.areas_addressed).toBe(2);
    expect(r.areas_resolved).toBe(1);   // product → overreaction (resolved)
    expect(r.areas_carried).toBe(1);    // management → carried to next quarter

    const open = await loadOpenAreas(id.AAPL);
    expect(open.length).toBe(1);                       // product resolved out
    expect(open[0].theme).toBe("management");
    const resolved = await db.pool.query("SELECT disposition FROM areas_of_interest WHERE company_id=$1 AND status='resolved'", [id.AAPL]);
    expect(resolved.rows.some((x) => x.disposition === "overreaction")).toBe(true);
  });

  it("forward pass stages a forward note and resolves a next date via cadence", async () => {
    const fr = await runForwardPass({ companyId: id.AAPL, analyst, sec, force: true });
    expect(fr.wrote).toBe(true);
    expect(fr.date_method).toBe("cadence"); // no Nasdaq adapter → cadence estimate from EDGAR
    expect(fr.next_earnings_date).toBe("2024-09-28"); // +91d from report period 2024-06-29

    const cf = await db.pool.query<{ ce: { forward_note?: { expectations?: string; break_conditions?: string[] } } }>(
      "SELECT current_events AS ce FROM canonical_files WHERE company_id=$1", [id.AAPL],
    );
    expect(cf.rows[0].ce.forward_note?.expectations).toContain("Services growth");
    expect(cf.rows[0].ce.forward_note?.break_conditions?.length).toBeGreaterThan(0);
  });
});
