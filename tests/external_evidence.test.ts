import { describe, it, expect } from "vitest";
import { externalBlock, fetchTranscript, fetchMarketData, type AskText } from "../lib/engines/external_evidence";

describe("externalBlock", () => {
  it("assembles labeled sourced items and skips nulls/empties", () => {
    const b = externalBlock([
      { label: "Earnings-call highlights", text: "HBM sold out through CY2026." },
      null,
      { label: "Market data", text: "  " },
    ]);
    expect(b).toContain("Earnings-call highlights:");
    expect(b).toContain("HBM sold out");
    expect(b).not.toContain("Market data");
  });
  it("returns empty when nothing came back", () => {
    expect(externalBlock([null, null])).toBe("");
  });
});

describe("fetch helpers", () => {
  const ok: AskText = { async askText() { return { ok: true, text: "sourced fact with a citation (2026)" }; } };
  const empty: AskText = { async askText() { return { ok: false }; } };
  it("fetchTranscript returns a labeled item on success, null otherwise", async () => {
    expect((await fetchTranscript(ok, { legal_name: "Micron", ticker: "MU" }))?.label).toMatch(/transcript/i);
    expect(await fetchTranscript(empty, { legal_name: "Micron", ticker: "MU" })).toBeNull();
  });
  it("fetchMarketData returns a labeled item on success", async () => {
    expect((await fetchMarketData(ok, { legal_name: "Micron", ticker: "MU", gics_sector: "IT" }))?.label).toMatch(/market/i);
  });
});
