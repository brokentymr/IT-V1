import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Company, CanonicalFile } from "./types";

const baseCompany = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  identifiers: { legal_name: "Acme Co.", tickers: ["ACME"] },
  classification: { gics_sector: "Energy", industry_group: null, industry: null, sub_industry: null },
  markets: [{ exchange: "NYSE", country: "US", region: "NA", currency: "USD", primary_filing_system: "SEC_EDGAR" }],
  coverage: { status: "watchlist" },
  ...over,
});

describe("§3 schema contract", () => {
  it("parses a valid company and applies defaults", () => {
    const c = Company.parse(baseCompany());
    expect(c.coverage.authors).toEqual([]);
    expect(c.coverage.positions_held).toEqual([]);
    expect(c.content_refs).toEqual([]);
  });

  it("allows a null GICS sector (best-effort classification)", () => {
    const c = Company.parse(baseCompany({
      classification: { gics_sector: null, industry_group: null, industry: null, sub_industry: null },
    }));
    expect(c.classification.gics_sector).toBeNull();
  });

  it("rejects an invalid coverage status", () => {
    expect(() => Company.parse(baseCompany({ coverage: { status: "bogus" } }))).toThrow();
  });

  it("rejects a non-uuid id", () => {
    expect(() => Company.parse(baseCompany({ id: "not-a-uuid" }))).toThrow();
  });

  it("builds a canonical skeleton with empty current_events", () => {
    const cf = CanonicalFile.parse({ company_id: randomUUID(), current_events: {}, snapshots: [] });
    expect(cf.current_events.rolling_outlook).toBe("");
    expect(cf.current_events.notes).toEqual([]);
    expect(cf.snapshots).toEqual([]);
  });
});
