import { describe, it, expect } from "vitest";
import { repairJson } from "../lib/llm/client";

// Parse-through helper: repair must yield something JSON.parse accepts.
const reparsed = (s: string) => JSON.parse(repairJson(s) as string);

describe("repairJson", () => {
  it("leaves already-valid JSON parseable (idempotent enough)", () => {
    const ok = '{"questions": [{"topic": "a", "question": "q?"}]}';
    expect(reparsed(ok)).toEqual({ questions: [{ topic: "a", question: "q?" }] });
  });

  // The real failure: the retrieval planner truncated mid-array-element at the token ceiling.
  it("salvages an array truncated mid-object, keeping the completed elements", () => {
    const truncated = '{"questions": [{"topic": "Competition", "question": "share vs peers?"}, {"topic": "Margins", "question": "restaurant-level margin trajec';
    const out = reparsed(truncated);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]).toEqual({ topic: "Competition", question: "share vs peers?" });
  });

  it("drops a dangling comma after the last complete element", () => {
    const truncated = '{"questions": [{"topic": "a", "question": "q1"}, {"topic": "b", "question": "q2"},';
    const out = reparsed(truncated);
    expect(out.questions).toHaveLength(2);
    expect(out.questions[1].topic).toBe("b");
  });

  it("strips surrounding code fences before repairing", () => {
    const fenced = '```json\n{"questions": [{"topic": "a", "question": "q"}, {"topic": "b", "quest';
    const out = reparsed(fenced);
    expect(out.questions).toHaveLength(1);
  });

  it("closes a nested object/array left open at truncation", () => {
    const truncated = '{"a": {"b": [1, 2, 3], "c": {"d": "done"}, "e": {"f": "cut';
    const out = repairJson(truncated);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out as string);
    expect(parsed.a.b).toEqual([1, 2, 3]);
    expect(parsed.a.c).toEqual({ d: "done" });
  });

  it("ignores braces that appear inside string values", () => {
    const truncated = '{"questions": [{"topic": "x", "question": "what about {curly} braces?"}, {"topic": "y", "ques';
    const out = reparsed(truncated);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].question).toContain("{curly}");
  });

  it("returns null when there is no object to salvage", () => {
    expect(repairJson("totally not json")).toBeNull();
    expect(repairJson("")).toBeNull();
  });
});
