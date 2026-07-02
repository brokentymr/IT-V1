import { describe, it, expect } from "vitest";
import { ENTITY_GATE } from "./entity_gate";
import { MONITOR_CONFIG } from "./monitor";

describe("ENTITY_GATE config (control P8)", () => {
  it("reuses the monitor flag band as the feed/scoring importance floor", () => {
    expect(ENTITY_GATE.otherCategoryImportanceFloor).toBe(MONITOR_CONFIG.bands.flag);
  });

  it("requires at least two signals and denylists the canonical collision tickers", () => {
    expect(ENTITY_GATE.minEntitySignals).toBe(2);
    expect(ENTITY_GATE.maxCollisionTickerLen).toBe(2);
    for (const t of ["MU", "GM", "F", "A", "ALL"]) expect(ENTITY_GATE.collisionTickers).toContain(t);
  });

  it("keeps common test tickers (AAPL/HPQ/AAA) OUT of the denylist so the gate stays a no-op for them", () => {
    for (const t of ["AAPL", "HPQ", "AAA", "BBB"]) expect(ENTITY_GATE.collisionTickers).not.toContain(t);
  });

  it("carries suffix stopwords and per-sector synonym vocab", () => {
    expect(ENTITY_GATE.nameSuffixStopwords).toContain("Inc");
    expect(ENTITY_GATE.nameSuffixStopwords).toContain("Technology");
    expect(ENTITY_GATE.sectorTermSynonyms["Information Technology"]).toContain("semiconductor");
  });
});
