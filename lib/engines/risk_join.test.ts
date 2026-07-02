import { describe, it, expect } from "vitest";
import { checkRiskTriggerJoin, blocks, type RiskJoinFinding } from "./risk_join";
import type { Risk, InvalidationTrigger } from "../types";

const risk = (o: Partial<Risk> = {}): Risk => ({
  id: "r1", title: "Margin compression", mechanism: "input costs rise faster than price",
  quantified_impact: null, severity: "medium", linked_trigger_id: null, ...o,
});
const trig = (o: Partial<InvalidationTrigger> = {}): InvalidationTrigger => ({
  id: "t1", condition: "gross margin falls >300bps QoQ", disclosure: "10-Q segment gross margin",
  source_ref: null, ...o,
});

describe("checkRiskTriggerJoin", () => {
  it("returns [] for empty inputs", () => {
    expect(checkRiskTriggerJoin([], [])).toEqual([]);
  });

  it("warns (not blocks) a risk with no linked trigger", () => {
    const f = checkRiskTriggerJoin([risk({ linked_trigger_id: null })], []);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("risk_without_trigger");
    expect(f[0].severity).toBe("warn");
    expect(blocks(f)).toHaveLength(0);
  });

  it("warns a risk whose linked_trigger_id does not resolve to a real trigger", () => {
    const f = checkRiskTriggerJoin([risk({ linked_trigger_id: "t9" })], [trig({ id: "t1" })]);
    // r1 -> t9 (unresolved) => warn; t1 unreferenced => block
    expect(f.some((x) => x.kind === "risk_without_trigger" && x.severity === "warn")).toBe(true);
    expect(f.some((x) => x.kind === "trigger_without_risk" && x.severity === "block")).toBe(true);
  });

  it("blocks a trigger referenced by no risk", () => {
    const f = checkRiskTriggerJoin([risk({ linked_trigger_id: null })], [trig()]);
    const b = blocks(f);
    expect(b.some((x) => x.kind === "trigger_without_risk")).toBe(true);
  });

  it("blocks a trigger with empty disclosure AND null source_ref (unverifiable)", () => {
    const f = checkRiskTriggerJoin(
      [risk({ linked_trigger_id: "t1" })],
      [trig({ id: "t1", disclosure: "   ", source_ref: null })],
    );
    expect(f.some((x) => x.kind === "trigger_without_disclosure" && x.severity === "block")).toBe(true);
  });

  it("does NOT block an empty-disclosure trigger when it carries a source_ref", () => {
    const f = checkRiskTriggerJoin(
      [risk({ linked_trigger_id: "t1" })],
      [trig({ id: "t1", disclosure: "", source_ref: "src-uuid" })],
    );
    expect(f.some((x) => x.kind === "trigger_without_disclosure")).toBe(false);
  });

  it("passes clean when every risk links a real, disclosed trigger and every trigger is referenced", () => {
    const f = checkRiskTriggerJoin(
      [risk({ id: "r1", linked_trigger_id: "t1" })],
      [trig({ id: "t1", disclosure: "10-Q gross margin", source_ref: null })],
    );
    expect(f).toEqual([]);
    expect(blocks(f)).toEqual([]);
  });

  it("blocks(findings) filters to severity==='block' only", () => {
    const findings: RiskJoinFinding[] = [
      { kind: "risk_without_trigger", severity: "warn", id: "r1", note: "" },
      { kind: "trigger_without_risk", severity: "block", id: "t1", note: "" },
    ];
    expect(blocks(findings)).toHaveLength(1);
    expect(blocks(findings)[0].id).toBe("t1");
  });
});
