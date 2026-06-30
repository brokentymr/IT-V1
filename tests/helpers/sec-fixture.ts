import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SecAdapter } from "../../lib/sources/sec";
import type { JsonFetcher } from "../../lib/sources/types";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sec");

/** A JsonFetcher backed by recorded SEC fixtures — no live API in tests (BUILD-PLAN §3). */
export const fixtureFetcher: JsonFetcher = async (url) => {
  if (url.includes("company_tickers.json")) {
    return { status: 200, body: JSON.parse(readFileSync(join(FIX, "company_tickers.json"), "utf8")) };
  }
  const m = url.match(/CIK(\d{10})\.json/);
  if (m) {
    try {
      return { status: 200, body: JSON.parse(readFileSync(join(FIX, `CIK${m[1]}.json`), "utf8")) };
    } catch {
      return { status: 404, body: null };
    }
  }
  return { status: 404, body: null };
};

export function fixtureSec(): SecAdapter {
  return new SecAdapter(fixtureFetcher);
}
