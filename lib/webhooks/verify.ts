import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string comparison (length-safe). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacSha256Hex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Verify an HMAC-SHA256 signature header (accepts "sha256=<hex>" or bare hex). */
export function verifyHmac(body: string, signature: string | null | undefined, secret: string): boolean {
  if (!signature) return false;
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return constantTimeEqual(provided.toLowerCase(), hmacSha256Hex(body, secret));
}

/** Verify a shared-secret token (e.g. embedded in a TradingView alert payload). */
export function verifySharedSecret(provided: unknown, secret: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  return constantTimeEqual(provided, secret);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
