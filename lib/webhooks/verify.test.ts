import { describe, it, expect } from "vitest";
import { hmacSha256Hex, verifyHmac, verifySharedSecret } from "./verify";

describe("webhook verification", () => {
  it("accepts a correct HMAC (bare hex and sha256= prefix)", () => {
    const sig = hmacSha256Hex("body", "secret");
    expect(verifyHmac("body", sig, "secret")).toBe(true);
    expect(verifyHmac("body", `sha256=${sig}`, "secret")).toBe(true);
  });

  it("rejects a wrong, tampered, or missing HMAC", () => {
    expect(verifyHmac("body", "deadbeef", "secret")).toBe(false);
    expect(verifyHmac("body", null, "secret")).toBe(false);
    expect(verifyHmac("tampered", hmacSha256Hex("body", "secret"), "secret")).toBe(false);
  });

  it("verifies a shared-secret token", () => {
    expect(verifySharedSecret("tok", "tok")).toBe(true);
    expect(verifySharedSecret("nope", "tok")).toBe(false);
    expect(verifySharedSecret(123, "tok")).toBe(false);
    expect(verifySharedSecret(undefined, "tok")).toBe(false);
  });
});
