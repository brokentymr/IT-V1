import { describe, it, expect } from "vitest";
import { groundedCoverage, applyGroundingGate, partitionClaims } from "../lib/engines/grounding";
import { normalizePlan, type PlanQuestion } from "../lib/engines/retrieval_planner";

const v = (statuses: Array<"supported" | "unverified" | "contradicted">, recommendation: "auto" | "review" = "auto", confidence = 0.8) =>
  ({ verdicts: statuses.map((status) => ({ status })), recommendation, confidence });

describe("groundedCoverage", () => {
  it("computes the fraction of claims backed by evidence (the Micron case ≈ 15%)", () => {
    const r = groundedCoverage(v(["supported", "supported", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified", "unverified"]));
    expect(r.supported).toBe(2);
    expect(r.total).toBe(13);
    expect(r.coverage).toBeCloseTo(2 / 13, 3);
  });
  it("is 0 with no verdicts to stand on", () => {
    expect(groundedCoverage(v([])).coverage).toBe(0);
  });
});

describe("groundedCoverage requireCitation (W4)", () => {
  const withCites = {
    verdicts: [
      { status: "supported" as const, citation: "XBRL: GM 84.6%" },
      { status: "supported" as const, citation: "" }, // supported but uncited
      { status: "unverified" as const },
    ],
    recommendation: "auto" as const,
    confidence: 0.7,
  };
  it("counts all supported without the flag", () => {
    expect(groundedCoverage(withCites).supported).toBe(2);
  });
  it("counts only CITED supported with the flag (uncited → unverified)", () => {
    const r = groundedCoverage(withCites, { requireCitation: true });
    expect(r.supported).toBe(1);
    expect(r.unverified).toBe(2);
  });
});

describe("applyGroundingGate", () => {
  it("downgrades a confident-but-ungrounded thesis to review (the Micron failure)", () => {
    const g = applyGroundingGate(v(["supported", "supported", ...Array(11).fill("unverified") as Array<"unverified">], "auto"), 0.6);
    expect(g.recommendation).toBe("review");
    expect(g.gated).toBe(true);
    expect(g.reason).toMatch(/grounded coverage/);
  });
  it("lets a well-grounded, clean thesis auto-publish", () => {
    const g = applyGroundingGate(v(["supported", "supported", "supported", "unverified"], "auto"), 0.6);
    expect(g.recommendation).toBe("auto");
    expect(g.gated).toBe(false);
  });
  it("blocks on any contradiction regardless of coverage", () => {
    const g = applyGroundingGate(v(["supported", "supported", "supported", "contradicted"], "auto"), 0.5);
    expect(g.recommendation).toBe("review");
    expect(g.reason).toMatch(/contradicted/);
  });
  it("never upgrades review → auto", () => {
    const g = applyGroundingGate(v(["supported", "supported", "supported"], "review"), 0.1);
    expect(g.recommendation).toBe("review");
    expect(g.gated).toBe(false);
  });

  // Integrity cap: too many claims dropped as `unverifiable` must not manufacture a false 100%.
  it("holds when more than the cap of load-bearing claims are unverifiable, despite 100% computed coverage", () => {
    const verification = {
      recommendation: "auto" as const,
      confidence: 0.8,
      verdicts: [
        { status: "supported" as const, citation: "10-Q: x" },
        { status: "supported" as const, citation: "10-Q: y" },
        { status: "unverified" as const, citation: "", unverifiable: true },
        { status: "unverified" as const, citation: "", unverifiable: true },
        { status: "unverified" as const, citation: "", unverifiable: true },
      ],
    };
    const g = applyGroundingGate(verification, 0.5, { requireCitation: true }, 0.34);
    expect(g.report.coverage).toBe(1);      // 2/2 on the counted claims
    expect(g.recommendation).toBe("review"); // but 3/5 unverifiable > 34% cap → held
    expect(g.reason).toMatch(/unverifiable/);
  });

  it("auto-publishes when unverifiable stays within the cap", () => {
    const verification = {
      recommendation: "auto" as const,
      confidence: 0.8,
      verdicts: [
        { status: "supported" as const, citation: "10-Q: a" },
        { status: "supported" as const, citation: "10-Q: b" },
        { status: "supported" as const, citation: "10-Q: c" },
        { status: "unverified" as const, citation: "", unverifiable: true }, // 1/4 = 25% ≤ cap
      ],
    };
    const g = applyGroundingGate(verification, 0.5, { requireCitation: true }, 0.34);
    expect(g.recommendation).toBe("auto");
    expect(g.gated).toBe(false);
  });
});

describe("partitionClaims", () => {
  it("separates grounded claims from analyst priors, treating unflagged as prior (fail-closed)", () => {
    const { grounded, priors } = partitionClaims([
      { statement: "a", grounded: true, confidence: 0.9 },
      { statement: "b", grounded: false, confidence: 0.9 },
      { statement: "c", confidence: 0.9 }, // unflagged → prior
    ] as Array<{ statement: string; grounded?: boolean; confidence: number }>);
    expect(grounded.map((c) => (c as { statement: string }).statement)).toEqual(["a"]);
    expect(priors).toHaveLength(2);
  });
});

describe("normalizePlan", () => {
  const q = (topic: string, question = "q?"): PlanQuestion => ({ topic, question, grounds: "" });
  it("dedupes by topic and caps", () => {
    const out = normalizePlan([q("DRAM share"), q("dram  share"), q("HBM customers"), q("Capex"), q("China mix"), q("Extra")], 3);
    expect(out.map((x) => x.topic)).toEqual(["DRAM share", "HBM customers", "Capex"]);
  });
  it("drops empty questions and empty topics", () => {
    const out = normalizePlan([{ topic: "", question: "x", grounds: "" }, { topic: "A", question: "", grounds: "" }, q("B")], 5);
    expect(out.map((x) => x.topic)).toEqual(["B"]);
  });
});
