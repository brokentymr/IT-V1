import { describe, it, expect } from "vitest";
import { applyVolumeFloor, shouldSuppressTempo, scrubTempo, type PlatformAggregate } from "./sentiment_floor";
import { SENTIMENT_CONFIG } from "../config/sentiment";

const cfg = SENTIMENT_CONFIG; // minVolumeForTrend 50, lowPrecisionVolume 100
const agg = (over: Partial<PlatformAggregate>): PlatformAggregate =>
  ({ platform: "stocktwits", volume: 200, sentiment: 0.333333, trend: "rising", top_themes: ["ai"], ...over });

describe("control P7 — sentiment volume floor (pure)", () => {
  describe("applyVolumeFloor", () => {
    it("below the trend floor: suppresses trend + net display, flags low_volume, KEEPS numeric", () => {
      const f = applyVolumeFloor(agg({ volume: 12, sentiment: 0.4123, trend: "rising" }), cfg);
      expect(f.trend).toBe("insufficient volume");
      expect(f.net_display).toBe("insufficient volume");
      expect(f.low_volume).toBe(true);
      expect(f.sentiment).toBe(0.4123); // numeric preserved for back-compat / downstream math
    });

    it("between the floors: caps net to one decimal (display + numeric), keeps the trend", () => {
      const f = applyVolumeFloor(agg({ volume: 60, sentiment: 0.3666, trend: "rising" }), cfg);
      expect(f.net_display).toBe("0.4");
      expect(f.sentiment).toBe(0.4);
      expect(f.low_volume).toBe(false);
      expect(f.trend).toBe("rising");
    });

    it("at/above the precision floor: full two-decimal net stands", () => {
      const f = applyVolumeFloor(agg({ volume: 150, sentiment: 0.333333 }), cfg);
      expect(f.net_display).toBe("0.33");
      expect(f.sentiment).toBe(0.33);
      expect(f.low_volume).toBe(false);
    });

    it("exactly at each floor boundary is inclusive (>= floor)", () => {
      expect(applyVolumeFloor(agg({ volume: cfg.minVolumeForTrend, sentiment: 0.25 }), cfg).low_volume).toBe(false);
      expect(applyVolumeFloor(agg({ volume: cfg.minVolumeForTrend - 1, sentiment: 0.25 }), cfg).low_volume).toBe(true);
      expect(applyVolumeFloor(agg({ volume: cfg.lowPrecisionVolume, sentiment: 0.256 }), cfg).net_display).toBe("0.26");
      expect(applyVolumeFloor(agg({ volume: cfg.lowPrecisionVolume - 1, sentiment: 0.256 }), cfg).net_display).toBe("0.3");
    });
  });

  describe("shouldSuppressTempo", () => {
    it("true only when EVERY contributing platform is below the floor", () => {
      expect(shouldSuppressTempo([{ volume: 5 }, { volume: 49 }], cfg)).toBe(true);
      expect(shouldSuppressTempo([{ volume: 5 }, { volume: 500 }], cfg)).toBe(false);
      expect(shouldSuppressTempo([{ volume: 500 }], cfg)).toBe(false);
    });
    it("vacuously true on an empty list (no volume anywhere)", () => {
      expect(shouldSuppressTempo([], cfg)).toBe(true);
    });
  });

  describe("scrubTempo", () => {
    it("strips banned velocity phrases case-insensitively", () => {
      expect(scrubTempo("Retail piling in.", cfg)).toBe("Retail.");
      expect(scrubTempo("Volume is SURGING here.", cfg)).toBe("Volume is here.");
      expect(scrubTempo("Momentum building for the name.", cfg)).toBe("for the name.");
    });
    it("leaves clean, non-tempo text untouched", () => {
      const s = "The crowd is split; bulls cite margins, bears cite valuation.";
      expect(scrubTempo(s, cfg)).toBe(s);
    });
    it("is idempotent and leaves no double-spaces or dangling punctuation", () => {
      const once = scrubTempo("Chatter is accelerating, and steady into the print.", cfg);
      expect(once).toBe(scrubTempo(once, cfg));
      expect(once).not.toMatch(/ {2,}/);
      expect(once).not.toMatch(/\s[,.;:]/);
      expect(once).not.toMatch(/^[,.;:]/);
    });
    it("removes empty parens the strip leaves behind", () => {
      expect(scrubTempo("Names (surging) higher.", cfg)).toBe("Names higher.");
    });
    it("no-ops when there are no banned phrases configured", () => {
      const emptyCfg = { ...cfg, tempoBannedPhrases: [] };
      expect(scrubTempo("Everything is surging.", emptyCfg)).toBe("Everything is surging.");
    });
  });
});
