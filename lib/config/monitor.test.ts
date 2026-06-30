import { describe, it, expect } from "vitest";
import { bandFor, statusFor } from "./monitor";

describe("importance rubric bands (§4.3)", () => {
  it("bands by score with the configured thresholds", () => {
    expect(bandFor(0)).toBe("low");
    expect(bandFor(39)).toBe("low");
    expect(bandFor(40)).toBe("material");
    expect(bandFor(69)).toBe("material");
    expect(bandFor(70)).toBe("major");
    expect(bandFor(100)).toBe("major");
  });

  it("maps band → note status", () => {
    expect(statusFor(20)).toBe("logged");
    expect(statusFor(50)).toBe("flagged");
    expect(statusFor(80)).toBe("escalated");
  });
});
