import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FmpTranscriptSource, segmentTranscript } from "./fmp_transcript";
import type { JsonFetcher } from "./types";

const SAMPLE = `Operator: Good afternoon and welcome to the Micron third quarter call.
Sanjay Mehrotra - CEO: We delivered record revenue. Our strategic customer agreements now cover committed volume of approximately $100 billion across 16 agreements on take-or-pay terms.
Mark Murphy - CFO: For the fourth quarter, we expect revenue of $50.0 billion plus or minus $1.0 billion and gross margin of approximately 86%.`;

const fake = (body: unknown, status = 200): JsonFetcher => async () => ({ status, body });

describe("FMP earnings-call transcript adapter", () => {
  const prev = process.env.FMP_API_KEY;
  beforeEach(() => { process.env.FMP_API_KEY = "test-key"; });
  afterEach(() => { if (prev === undefined) delete process.env.FMP_API_KEY; else process.env.FMP_API_KEY = prev; });

  it("returns the verbatim transcript, tolerant of FMP's array-of-one shape", async () => {
    const src = new FmpTranscriptSource(fake([{ symbol: "MU", year: 2026, quarter: 3, date: "2026-06-24 16:30:00", content: SAMPLE }]));
    const r = await src.earningsTranscript("MU");
    expect(r.ok).toBe(true);
    expect(r.data?.event_type).toBe("earnings_call");
    expect(r.data?.date).toBe("2026-06-24");
    expect(r.data?.raw).toContain("$100 billion");
    expect(r.data?.raw).toContain("take-or-pay");
    // the key never leaks into stored provenance
    expect(r.data?.url).not.toContain("test-key");
  });

  it("segments prepared remarks into speaker/role turns", async () => {
    const segs = segmentTranscript(SAMPLE);
    const ceo = segs.find((s) => s.speaker?.includes("Sanjay"));
    expect(ceo?.role).toMatch(/CEO/);
    expect(ceo?.text).toContain("$100 billion");
  });

  it("degrades (ok=false) with no API key", async () => {
    delete process.env.FMP_API_KEY;
    const src = new FmpTranscriptSource(fake([{ content: SAMPLE }]));
    expect(src.available()).toBe(false);
    const r = await src.earningsTranscript("MU");
    expect(r.ok).toBe(false);
    expect(r.missing.join(" ")).toMatch(/FMP_API_KEY/);
  });

  it("degrades on an empty/short response (no transcript for the name)", async () => {
    const src = new FmpTranscriptSource(fake([]));
    const r = await src.earningsTranscript("MU");
    expect(r.ok).toBe(false);
  });
});
