import { describe, it, expect } from "vitest";
import { SecAdapter } from "./sec";
import type { JsonFetcher } from "./types";

// A fake EDGAR that serves an 8-K earnings release (Item 2.02) whose archive index lists a press-release
// exhibit alongside the cover body and XBRL rendering files — the real shape earningsRelease resolves.
function fakeEdgar(items: string): JsonFetcher {
  return async (url) => {
    if (url.includes("/submissions/")) {
      return { status: 200, body: { filings: { recent: {
        accessionNumber: ["0000723125-26-000013", "0000723125-26-000006"],
        form: ["8-K", "10-Q"],
        filingDate: ["2026-06-24", "2026-04-02"],
        reportDate: ["2026-06-24", "2026-02-26"],
        primaryDocument: ["mu-20260624.htm", "mu-20260226.htm"],
        items: [items, ""],
      } } } };
    }
    if (url.endsWith("/index.json")) {
      return { status: 200, body: { directory: { item: [
        { name: "mu-20260624.htm" },              // the 8-K cover body — must NOT be chosen
        { name: "R1.htm" },                        // XBRL rendering — must NOT be chosen
        { name: "a2026q3ex991-pressrelease.htm" }, // the earnings release — the one we want
      ] } } };
    }
    return { status: 404, body: null };
  };
}

describe("earnings-release resolution (Layer 2)", () => {
  it("finds the 8-K Item 2.02 and resolves its EX-99.1 press release (not the cover body or XBRL rendering)", async () => {
    const sec = new SecAdapter(fakeEdgar("2.02,9.01"));
    const r = await sec.earningsRelease("0000723125");
    expect(r.ok).toBe(true);
    expect(r.data?.accession).toBe("0000723125-26-000013");
    expect(r.data?.url).toMatch(/a2026q3ex991-pressrelease\.htm$/);
  });

  it("degrades (not ok) when no 8-K reports results of operations", async () => {
    const sec = new SecAdapter(fakeEdgar("5.02")); // a departure-of-directors 8-K, not earnings
    const r = await sec.earningsRelease("0000723125");
    expect(r.ok).toBe(false);
    expect(r.missing.join(" ")).toMatch(/item 2\.02/i);
  });

  it("recentFilings now carries 8-K item codes", async () => {
    const sec = new SecAdapter(fakeEdgar("2.02,9.01"));
    const f = await sec.recentFilings("0000723125", { forms: ["8-K"] });
    expect(f.data?.[0].items).toBe("2.02,9.01");
  });
});
