/**
 * Universe / Explorer read model (Phase 5, spec §7.3). Faceted list of covered assets with a
 * one-line summary pulled from each company's latest snapshot — the entry point to select an asset.
 */
import { query } from "../db/pool";

export interface UniverseRow {
  id: string;
  legal_name: string;
  primary_ticker: string | null;
  gics_sector: string | null;
  coverage_status: string;
  content_enrolled: boolean;
  next_earnings_date: string | null;
  latest_as_of: string | null;
  conviction: number | null;
  one_liner: string | null;
  link_count: number;
  flagged_notes: number;
}

export interface UniverseFilters { q?: string; sector?: string; status?: string }

export async function listUniverse(f: UniverseFilters = {}): Promise<UniverseRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) { params.push(`%${f.q}%`); where.push(`(c.legal_name ILIKE $${params.length} OR c.primary_ticker ILIKE $${params.length})`); }
  if (f.sector) { params.push(f.sector); where.push(`c.gics_sector = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`c.coverage_status = $${params.length}`); }
  const { rows } = await query<UniverseRow>(
    `SELECT c.id, c.legal_name, c.primary_ticker, c.gics_sector, c.coverage_status, c.content_enrolled,
            to_char(c.next_earnings_date,'YYYY-MM-DD') AS next_earnings_date,
            to_char(s.as_of,'YYYY-MM-DD') AS latest_as_of, s.conviction,
            s.content->'thesis'->>'one_liner' AS one_liner,
            (SELECT count(*) FROM company_links cl WHERE cl.from_company_id = c.id)::int AS link_count,
            (SELECT count(*) FROM news_notes n WHERE n.company_id = c.id AND n.status IN ('flagged','escalated'))::int AS flagged_notes
       FROM companies c
       LEFT JOIN LATERAL (
         SELECT as_of, conviction, content FROM canonical_snapshots cs
          WHERE cs.company_id = c.id ORDER BY cs.as_of DESC, cs.created_at DESC LIMIT 1
       ) s ON true
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.legal_name`,
    params,
  );
  return rows;
}

export async function universeFacets(): Promise<{ sectors: string[]; statuses: string[] }> {
  const sectors = await query<{ v: string }>(
    "SELECT DISTINCT gics_sector AS v FROM companies WHERE gics_sector IS NOT NULL ORDER BY 1",
  );
  const statuses = await query<{ v: string }>(
    "SELECT DISTINCT coverage_status AS v FROM companies ORDER BY 1",
  );
  return { sectors: sectors.rows.map((r) => r.v), statuses: statuses.rows.map((r) => r.v) };
}
