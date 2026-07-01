import { describe, it, expect } from "vitest";
import { detectTrueDataRejection, decisionCompleteness, groundednessScore, coherenceState, evaluateSnapshot, type EvalContent } from "../lib/eval/desk_eval";

// The ORIGINAL Micron output (pre-upgrade): rejected the real 84.9% margin, ungrounded, decision-free.
const oldMicron: EvalContent = {
  research: {
    panel: [
      { lens: "risk", summary: "Micron's reported Q3 2026 financials are statistically implausible — 84.6% gross margins for a commodity manufacturer strongly suggest data corruption or XBRL tagging errors.", claims: [{ statement: "The reported XBRL figures contain material errors and should not be used as ground truth.", grounded: true }] },
      { lens: "equity", summary: "The XBRL figures likely aggregate trailing twelve months rather than a single quarter, as they are outside any plausible range.", claims: [] },
    ],
    verification: {
      verdicts: [
        { claim: "Q3 figures match the HTML 10-Q", status: "unverified", note: "Only XBRL extraction is provided." },
        { claim: "Beat consensus", status: "supported", note: "Consensus confirms the beat." },
        ...Array(11).fill(0).map((_, i) => ({ claim: `prior claim ${i}`, status: "unverified", note: "not established" })),
      ],
      confidence: 0.45,
    },
    grounding: { coverage: 2 / 13, supported: 2, total: 13 },
  },
  // no positioning (description-only), no scenario coherence
};

// A hypothetical UPGRADED output: leaned into the surprise, grounded, decided, coherent.
const newMicron: EvalContent = {
  research: {
    panel: [{ lens: "sector", summary: "Micron's record 84.9% gross margin reflects an HBM/AI memory supercycle and supply discipline — the key debate is durability.", claims: [{ statement: "HBM ASP premiums drove the margin step-up", grounded: true }] }],
    verification: { verdicts: [{ claim: "margin driven by HBM", status: "supported", note: "transcript + segment data" }, { claim: "share ~25%", status: "supported", note: "TrendForce" }, { claim: "china exposure", status: "unverified", note: "" }], confidence: 0.68 },
    grounding: { coverage: 2 / 3, supported: 2, total: 3 },
  },
  positioning: { strategic_stance: "constructive", variant_view: "Street targets are internally incoherent; we think margins hold ~2 quarters.", catalysts: [{ event: "FQ4 print" }], price_target: { bear: 78, base: 145, bull: 240 } },
  scenario: { coherence: { agree: true, note: "coherent" } },
};

describe("detectTrueDataRejection", () => {
  it("catches the old Micron rejecting real data (the failure that started the review)", () => {
    const r = detectTrueDataRejection(oldMicron);
    expect(r.rejected).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
  });
  it("does not fire on an output that leaned into the surprise", () => {
    expect(detectTrueDataRejection(newMicron).rejected).toBe(false);
  });
});

describe("groundednessScore + decisionCompleteness + coherenceState", () => {
  it("reads the stamped grounding coverage", () => {
    expect(groundednessScore(oldMicron)).toBeCloseTo(2 / 13, 3);
    expect(groundednessScore(newMicron)).toBeCloseTo(2 / 3, 3);
  });
  it("flags the old output as decision-incomplete and the new one as complete", () => {
    expect(decisionCompleteness(oldMicron).complete).toBe(false);
    expect(decisionCompleteness(newMicron).complete).toBe(true);
  });
  it("reports coherence state, null when no scenario", () => {
    expect(coherenceState(oldMicron)).toBeNull();
    expect(coherenceState(newMicron)).toBe(true);
  });
});

describe("evaluateSnapshot", () => {
  it("grades the old Micron an F (true-data rejection)", () => {
    const s = evaluateSnapshot(oldMicron);
    expect(s.grade).toBe("F");
    expect(s.trueDataRejection).toBe(true);
    expect(s.issues.join(" ")).toMatch(/true-data rejection/);
  });
  it("grades the upgraded output an A", () => {
    const s = evaluateSnapshot(newMicron);
    expect(s.grade).toBe("A");
    expect(s.decisionComplete).toBe(true);
    expect(s.issues).toHaveLength(0);
  });
});
