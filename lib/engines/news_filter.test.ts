import { describe, it, expect } from "vitest";
import { hasWord, isCollisionProne, countEntitySignals, entityGate, isFeedSuppressed } from "./news_filter";
import { ENTITY_GATE } from "../config/entity_gate";

const micron = { legalName: "Micron Technology, Inc.", ticker: "MU", exchange: "NASDAQ", gicsSector: "Information Technology" };
const apple = { legalName: "Apple Inc.", ticker: "AAPL", exchange: "NASDAQ", gicsSector: "Information Technology" };

describe("hasWord — word-boundary, case-insensitive", () => {
  it("does NOT match a short term inside a larger word", () => {
    expect(hasWord("Museum opens new exhibit", "mu")).toBe(false);
    expect(hasWord("A gm crop debate", "GM")).toBe(true); // standalone word matches (case-insensitive)
  });
  it("matches a $TICKER cashtag despite the leading $", () => {
    expect(hasWord("buy $MU today", "$MU")).toBe(true);
    expect(hasWord("nothing here", "$MU")).toBe(false);
  });
  it("ignores empty terms", () => {
    expect(hasWord("anything", "")).toBe(false);
  });
});

describe("isCollisionProne", () => {
  it("flags short tickers and denylisted tickers", () => {
    expect(isCollisionProne("MU", ENTITY_GATE)).toBe(true); // denylist
    expect(isCollisionProne("F", ENTITY_GATE)).toBe(true); // length 1
    expect(isCollisionProne("ALL", ENTITY_GATE)).toBe(true); // denylist though length 3
  });
  it("treats normal tickers as safe", () => {
    expect(isCollisionProne("AAPL", ENTITY_GATE)).toBe(false);
    expect(isCollisionProne("HPQ", ENTITY_GATE)).toBe(false);
    expect(isCollisionProne("AAA", ENTITY_GATE)).toBe(false);
  });
});

describe("countEntitySignals", () => {
  it("counts a suffix-stripped name token + sector term as two signals", () => {
    const { signals } = countEntitySignals(
      { title: "Micron raises semiconductor guidance", snippet: null }, micron, ENTITY_GATE,
    );
    expect(signals.some((s) => s.startsWith("name:Micron"))).toBe(true);
    expect(signals.some((s) => s.startsWith("sector:semiconductor"))).toBe(true);
    expect(signals.length).toBeGreaterThanOrEqual(2);
  });
  it("counts a cashtag as a signal", () => {
    const { signals } = countEntitySignals({ title: "chart of $MU", snippet: null }, micron, ENTITY_GATE);
    expect(signals).toContain("cashtag");
  });
  it("finds zero signals in unrelated prose (the museum false positive)", () => {
    const { signals } = countEntitySignals(
      { title: "Local museum opens new mu-themed exhibit", snippet: "art downtown" }, micron, ENTITY_GATE,
    );
    expect(signals).toHaveLength(0);
  });
});

describe("entityGate", () => {
  it("is a strict no-op for non-collision-prone tickers (passes anything)", () => {
    const r = entityGate({ title: "totally unrelated headline", snippet: null }, apple, [], ENTITY_GATE);
    expect(r.passed).toBe(true);
  });
  it("passes a collision-prone ticker with enough signals", () => {
    const r = entityGate({ title: "Micron lifts semiconductor outlook", snippet: null }, micron, [], ENTITY_GATE);
    expect(r.passed).toBe(true);
  });
  it("fails a collision-prone ticker with insufficient signals", () => {
    const r = entityGate({ title: "Local museum opens exhibit", snippet: null }, micron, [], ENTITY_GATE);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("insufficient_signals");
  });
  it("fails on a learned denylist phrase (word-boundary, not substring)", () => {
    const r = entityGate({ title: "mu greek letter primer", snippet: null }, micron, ["mu greek letter primer"], ENTITY_GATE);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("known_collision");
    expect(r.matchedTerm).toBe("mu greek letter primer");
    // the same denylist term must NOT trip on a word that merely contains it
    expect(entityGate({ title: "Museum tour", snippet: null }, micron, ["mu"], ENTITY_GATE).reason).not.toBe("known_collision");
  });
});

describe("isFeedSuppressed", () => {
  it("suppresses only low-importance 'other' notes", () => {
    expect(isFeedSuppressed("other", 10, ENTITY_GATE)).toBe(true);
    expect(isFeedSuppressed("other", 90, ENTITY_GATE)).toBe(false);
    expect(isFeedSuppressed("guidance", 10, ENTITY_GATE)).toBe(false);
  });
});
