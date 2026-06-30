import type { Queue } from "../queue/types";

/** Blob storage port (DO Spaces in production; a fake in tests). */
export interface BlobStore {
  put(key: string, body: string, contentType: string): Promise<{ key: string }>;
}

export type { Queue };

export type WebhookStatus =
  | "ok"
  | "duplicate"        // idempotent replay
  | "unauthorized"     // bad/missing secret or signature
  | "unknown_company"  // symbol/cik not in the universe
  | "bad_request";     // unparseable / missing fields
