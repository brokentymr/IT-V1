/**
 * Read-through relationships store (control P12). enrichLinks only linked counterparties already in our
 * universe; the uncovered ones (and the demand-side customers pulled from the filing) are captured here
 * as first-class read-through edges the reader surface can render. Latest coverage wins via upsert;
 * migration 0022 owns the table (separate-mutable-table pattern — canonical_snapshots is append-only).
 */
import { query } from "../db/pool";
import type { Pool, PoolClient } from "pg";

type Queryable = Pool | PoolClient;

export interface ReadThroughUpsert {
  companyId: string;
  snapshotId: string | null;
  counterpartyName: string;
  ticker?: string | null;
  type: string;
  materiality?: string | null;
  rationale?: string | null;
  readThrough?: string | null;
  toCompanyId?: string | null;
  sourceRef?: string | null;
}

export interface ReadThroughRelationship {
  id: string;
  counterparty_name: string;
  ticker: string | null;
  type: string | null;
  materiality: string | null;
  rationale: string | null;
  read_through: string | null;
  to_company_id: string | null;
  to_name: string | null;
  to_ticker: string | null;
  source_ref: string | null;
}

/** Upsert one read-through edge (latest snapshot_id/source_ref wins). Returns rows affected (0|1). */
export async function upsertReadThrough(client: Queryable, row: ReadThroughUpsert): Promise<number> {
  const res = await client.query(
    `INSERT INTO read_through_relationships
       (company_id, snapshot_id, counterparty_name, ticker, type, materiality, rationale, read_through, to_company_id, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (company_id, lower(counterparty_name), type) DO UPDATE SET
       snapshot_id   = EXCLUDED.snapshot_id,
       ticker        = COALESCE(EXCLUDED.ticker, read_through_relationships.ticker),
       materiality   = EXCLUDED.materiality,
       rationale     = EXCLUDED.rationale,
       read_through  = EXCLUDED.read_through,
       to_company_id = COALESCE(EXCLUDED.to_company_id, read_through_relationships.to_company_id),
       source_ref    = COALESCE(EXCLUDED.source_ref, read_through_relationships.source_ref)`,
    [row.companyId, row.snapshotId, row.counterpartyName, row.ticker ?? null, row.type,
      row.materiality ?? null, row.rationale ?? null, row.readThrough ?? null, row.toCompanyId ?? null, row.sourceRef ?? null],
  );
  return res.rowCount ?? 0;
}

/** Once a counterparty becomes covered, point any earlier uncovered edge at the covered company. */
export async function linkReadThroughMatch(client: Queryable, companyId: string, counterpartyName: string, toCompanyId: string): Promise<number> {
  const res = await client.query(
    `UPDATE read_through_relationships SET to_company_id = $3
      WHERE company_id = $1 AND lower(counterparty_name) = lower($2) AND to_company_id IS NULL`,
    [companyId, counterpartyName, toCompanyId],
  );
  return res.rowCount ?? 0;
}

/** Load the read-through edges for a company, most-material first (covered ones resolve their name). */
export async function loadReadThrough(companyId: string): Promise<ReadThroughRelationship[]> {
  const { rows } = await query<ReadThroughRelationship>(
    `SELECT r.id, r.counterparty_name, r.ticker, r.type, r.materiality, r.rationale, r.read_through,
            r.to_company_id::text AS to_company_id, c.legal_name AS to_name, c.primary_ticker AS to_ticker,
            r.source_ref::text AS source_ref
       FROM read_through_relationships r
       LEFT JOIN companies c ON c.id = r.to_company_id
      WHERE r.company_id = $1
      ORDER BY CASE r.materiality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
               r.counterparty_name`,
    [companyId],
  );
  return rows;
}
