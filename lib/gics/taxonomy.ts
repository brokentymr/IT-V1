import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { classifyBySic } from "./sicCrosswalk";

export interface GicsNode {
  code: string;
  name: string;
  level: "sector" | "industry_group" | "industry" | "sub_industry";
  parent_code: string | null;
}

const DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), "gics-taxonomy.json");
export const GICS_TAXONOMY: GicsNode[] = JSON.parse(readFileSync(DATA_PATH, "utf8"));
const BY_CODE = new Map(GICS_TAXONOMY.map((n) => [n.code, n]));

export function gicsName(code: string | null): string | null {
  return code ? (BY_CODE.get(code)?.name ?? null) : null;
}

export interface GicsClassification {
  gics_sector: string | null;
  industry_group: string | null;
  industry: string | null;
  sub_industry: string | null;
  confidence: number;
  basis: string;
}

/** Classify a company from its SEC SIC code into a (best-effort) GICS path. */
export function classifyFromSic(sic: string | number | null | undefined): GicsClassification {
  const m = classifyBySic(sic);
  return {
    gics_sector: gicsName(m.sector_code),
    industry_group: gicsName(m.group_code),
    industry: null,      // not reachable from SIC alone (Phase 1)
    sub_industry: null,  // not reachable from SIC alone (Phase 1)
    confidence: m.confidence,
    basis: sic ? `SIC ${sic}` : "unknown",
  };
}

/** Idempotently seed the GICS taxonomy into the `sectors` table. */
export async function seedGics(pool: Pool): Promise<number> {
  // Parents must exist before children (FK self-reference); JSON is ordered sector→group.
  for (const n of GICS_TAXONOMY) {
    await pool.query(
      `INSERT INTO sectors (code, name, level, parent_code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, level = EXCLUDED.level, parent_code = EXCLUDED.parent_code`,
      [n.code, n.name, n.level, n.parent_code],
    );
  }
  return GICS_TAXONOMY.length;
}
