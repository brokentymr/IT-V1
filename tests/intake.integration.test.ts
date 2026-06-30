import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { fixtureSec } from "./helpers/sec-fixture";
import { FakeQueue } from "./helpers/fakes";
import { setPool } from "../lib/db/pool";
import { SecAdapter } from "../lib/sources/sec";
import type { JsonFetcher } from "../lib/sources/types";
import { PerplexityClient, type PerplexityFetcher } from "../lib/sources/perplexity";
import { resolveEntities, addResolvedEntity, createUnlistedCompany } from "../lib/engines/intake";
import { runPrivateProfile } from "../lib/engines/private_profile";

const RESOLVE_JSON = JSON.stringify({
  entities: [
    { name: "Apple Inc.", ticker: "aapl", listing: "listed", exchange: "NASDAQ", sector: "Information Technology", rationale: "the named company" },
    { name: "SpaceX", ticker: null, listing: "private", exchange: null, sector: "Industrials", rationale: "private peer" },
  ],
  research_focus: ["device price increases", "demand destruction"],
});

// A SEC adapter for the pre-IPO S-1 path: name→CIK via FTS, then a CIK submissions record.
const preIpoFetcher: JsonFetcher = async (url) => {
  if (url.includes("efts.sec.gov")) return { status: 200, body: { hits: { hits: [{ _source: { ciks: ["0001999999"], display_names: ["NewCo Inc. (CIK 0001999999)"] } }] } } };
  if (url.includes("CIK0001999999")) return { status: 200, body: { name: "NewCo Inc.", sic: "7372", sicDescription: "Prepackaged Software", tickers: [], exchanges: [], fiscalYearEnd: "1231" } };
  return { status: 404, body: null };
};
const PROFILE_JSON = JSON.stringify({
  profile: { description: "Rocket and satellite company.", founded: "2002", headquarters: "Hawthorne, CA", total_funding: "$10B+", last_valuation: "$350B", key_investors: ["Founders Fund"], competitors: ["Rocket Lab"], recent: "Starship tests." },
  thesis: { one_liner: "Dominant launch provider.", long_form: "Long.", opportunities: ["Starlink"], risks: ["Execution"], conviction: 4 },
});

const fakeFetcher: PerplexityFetcher = async (body) => {
  const q = (body as { messages: Array<{ content: string }> }).messages.slice(-1)[0].content;
  const content = /research profile/i.test(q) ? PROFILE_JSON : RESOLVE_JSON;
  return { status: 200, body: { choices: [{ message: { content } }], citations: ["https://ex.com"], usage: { cost: { total_cost: 0.004 } } } };
};

describe("agentic intake (integration)", () => {
  let db: Ephemeral;
  const client = new PerplexityClient(fakeFetcher);
  beforeAll(async () => { db = await createEphemeralDb(); setPool(db.pool); });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("resolves free text to entities + research focus (tickers normalized)", async () => {
    const r = await resolveEntities("Apple device price increases and a private peer", { client });
    expect(r.entities.length).toBe(2);
    expect(r.entities[0]).toMatchObject({ name: "Apple Inc.", ticker: "AAPL", listing: "listed" });
    expect(r.entities[1]).toMatchObject({ name: "SpaceX", ticker: null, listing: "private" });
    expect(r.research_focus).toContain("device price increases");
  });

  it("adds a PRE-IPO S-1 filer by CIK (not as a profile-only private name)", async () => {
    const queue = new FakeQueue();
    const out = await addResolvedEntity(
      { name: "NewCo Inc.", ticker: null, listing: "pre_ipo", exchange: null, sector: "Information Technology", rationale: "filed S-1" },
      { sec: new SecAdapter(preIpoFetcher), queue, autoRun: true, research_focus: ["path to profitability"] },
    );
    expect(out.result).toBe("ingested");
    expect(out.listing).toBe("pre_ipo");
    const c = await db.pool.query("SELECT cik, primary_ticker, listing, coverage->'research_focus' focus FROM companies WHERE id=$1", [out.company_id]);
    expect(c.rows[0].cik).toBe("0001999999");
    expect(c.rows[0].primary_ticker).toBeNull();
    expect(c.rows[0].listing).toBe("pre_ipo");
    expect(c.rows[0].focus).toEqual(["path to profitability"]); // research focus stored for the engines
  });

  it("adds a LISTED entity via SEC ingest", async () => {
    const queue = new FakeQueue();
    const out = await addResolvedEntity(
      { name: "Apple Inc.", ticker: "AAPL", listing: "listed", exchange: "NASDAQ", sector: "IT", rationale: "x" },
      { sec: fixtureSec(), queue, autoRun: true, research_focus: ["device price increases"] },
    );
    expect(out.result).toBe("ingested");
    expect(out.listing).toBe("listed");
    const c = await db.pool.query("SELECT primary_ticker, listing, coverage->'research_focus' focus FROM companies WHERE id=$1", [out.company_id]);
    expect(c.rows[0].primary_ticker).toBe("AAPL");
    expect(c.rows[0].listing).toBe("listed");
    expect(c.rows[0].focus).toEqual(["device price increases"]);
  });

  it("adds a PRIVATE entity as a tickerless record and enqueues a profile pass", async () => {
    const queue = new FakeQueue();
    const out = await addResolvedEntity(
      { name: "SpaceX", ticker: null, listing: "private", exchange: null, sector: "Industrials", rationale: "y" },
      { queue, autoRun: true },
    );
    expect(out.result).toBe("created");
    expect(out.research).toBe("profile");
    const c = await db.pool.query("SELECT primary_ticker, cik, listing, gics_sector FROM companies WHERE id=$1", [out.company_id]);
    expect(c.rows[0].primary_ticker).toBeNull();
    expect(c.rows[0].cik).toBeNull();
    expect(c.rows[0].listing).toBe("private");
    expect(queue.jobs.some((j) => j.name === "profile-pass")).toBe(true);
    // idempotent on name
    const again = await createUnlistedCompany({ name: "SpaceX", sector: "Industrials", listing: "private" });
    expect(again.status).toBe("exists");
    expect(again.company_id).toBe(out.company_id);
  });

  it("runs a Perplexity profile pass → a snapshot with a profile + thesis", async () => {
    const { company_id } = await createUnlistedCompany({ name: "Anthropic", sector: "Information Technology", listing: "private" });
    const out = await runPrivateProfile(company_id, { client });
    expect(out.ok).toBe(true);
    const snap = await db.pool.query("SELECT cycle_label, content FROM canonical_snapshots WHERE snapshot_id=$1", [out.snapshot_id]);
    expect(snap.rows[0].cycle_label).toBe("Profile");
    const content = snap.rows[0].content as { profile?: { last_valuation?: string }; thesis?: { one_liner?: string; conviction?: number } };
    expect(content.profile?.last_valuation).toBe("$350B");
    expect(content.thesis?.one_liner).toBe("Dominant launch provider.");
    expect(content.thesis?.conviction).toBe(4);
  });
});
