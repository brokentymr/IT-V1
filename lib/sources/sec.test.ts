import { describe, it, expect } from "vitest";
import { SecAdapter, cik10 } from "./sec";
import { fixtureFetcher } from "../../tests/helpers/sec-fixture";

describe("SEC EDGAR adapter (recorded fixtures)", () => {
  const sec = new SecAdapter(fixtureFetcher);

  it("zero-pads CIKs to 10 digits", () => {
    expect(cik10(320193)).toBe("0000320193");
    expect(cik10("320193")).toBe("0000320193");
  });

  it("resolves a ticker to its CIK with provenance", async () => {
    const r = await sec.resolveTicker("aapl");
    expect(r.ok).toBe(true);
    expect(r.data?.cik).toBe("0000320193");
    expect(r.provenance?.origin).toBe("SEC EDGAR");
  });

  it("degrades (does not throw) on an unknown ticker", async () => {
    const r = await sec.resolveTicker("ZZZZ");
    expect(r.ok).toBe(false);
    expect(r.data).toBeNull();
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it("fetches company identity including SIC", async () => {
    const r = await sec.companyIdentity("0000320193");
    expect(r.ok).toBe(true);
    expect(r.data?.legal_name).toBe("Apple Inc.");
    expect(r.data?.sic).toBe("3571");
    expect(r.data?.exchanges).toContain("Nasdaq");
  });
});
