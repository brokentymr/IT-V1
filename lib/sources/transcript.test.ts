import { describe, it, expect, afterEach } from "vitest";
import { transcriptExcerpt, transcriptEvidenceBlock, resolveTranscriptSource, type TranscriptDoc } from "./transcript";

const doc = (raw: string): TranscriptDoc => ({
  symbol: "MU", event_type: "earnings_call", title: "MU earnings call", date: "2026-06-24",
  provider: "fmp", url: "https://fmp/transcript", raw, segments: [{ speaker: null, role: null, text: raw }],
});

describe("transcript excerpting + evidence", () => {
  it("keeps the lead AND surfaces buried guidance/committed-volume language within budget", () => {
    const raw = "Opening remarks about the record quarter. " + "filler sentence about operations. ".repeat(2000) +
      "For the fourth quarter we expect revenue of $50.0 billion. Committed volume across take-or-pay agreements is $100 billion.";
    const ex = transcriptExcerpt(doc(raw), 4000);
    expect(ex.length).toBeLessThanOrEqual(4000);
    expect(ex).toMatch(/Opening remarks/);         // lead preserved
    expect(ex).toMatch(/\$50\.0 billion|committed|take-or-pay|\$100 billion/i); // buried thesis content surfaced
  });

  it("labels the evidence block as verbatim primary, citable as transcript", () => {
    const block = transcriptEvidenceBlock(doc("short call text"));
    expect(block).toMatch(/VERBATIM/);
    expect(block).toMatch(/cite as 'transcript'/);
    expect(block).toContain("2026-06-24");
  });

  it("returns short transcripts whole (no excerpting under budget)", () => {
    expect(transcriptExcerpt(doc("brief remarks"), 4000)).toBe("brief remarks");
  });
});

describe("transcript source resolution", () => {
  const prev = process.env.FMP_API_KEY;
  afterEach(() => { if (prev === undefined) delete process.env.FMP_API_KEY; else process.env.FMP_API_KEY = prev; });

  it("returns null (→ Perplexity fallback) when the provider has no key configured", () => {
    delete process.env.FMP_API_KEY;
    expect(resolveTranscriptSource()).toBeNull();
  });

  it("returns the FMP source when a key is present", () => {
    process.env.FMP_API_KEY = "test-key";
    expect(resolveTranscriptSource()?.name).toBe("fmp");
  });
});
