import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Load .env into process.env for scripts and tests (Next.js loads it on its own
 * for the app). Existing process.env values win, so explicit overrides hold.
 */
export function loadEnv(path = join(ROOT, ".env")): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    /* .env optional when the environment is already populated */
  }
}
