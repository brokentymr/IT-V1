/**
 * Content persistence (Phase 8). Structured consumable bodies land in content_items (jsonb); a rendered
 * artifact (PDF/MD) may also be pushed to Spaces and referenced by blob_ref. The Content Library reads
 * from here.
 */
import { query } from "../db/pool";

export type ContentType = "deck" | "newsletter" | "shortform" | "podcast";

export interface ContentItem {
  id: string;
  company_id: string;
  snapshot_id: string | null;
  type: ContentType;
  title: string;
  body: unknown;
  provenance: unknown[];
  disclosure: string | null;
  blob_ref: string | null;
  status: string;
  created_at: string;
}

const FORMAT: Record<ContentType, string> = { deck: "html", newsletter: "markdown", shortform: "json", podcast: "doc" };
const AUDIENCE: Record<ContentType, string> = { deck: "audience", newsletter: "audience", shortform: "production", podcast: "production" };

export async function saveContentItem(input: {
  companyId: string;
  snapshotId: string | null;
  type: ContentType;
  title: string;
  body: unknown;
  provenance?: unknown[];
  disclosure?: string | null;
  blobRef?: string | null;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO content_items (company_id, snapshot_id, type, format, audience, title, body, provenance, disclosure, blob_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [input.companyId, input.snapshotId, input.type, FORMAT[input.type], AUDIENCE[input.type], input.title,
      JSON.stringify(input.body), JSON.stringify(input.provenance ?? []), input.disclosure ?? null, input.blobRef ?? null],
  );
  return rows[0].id;
}

export async function getContentItem(id: string): Promise<ContentItem | null> {
  const { rows } = await query<ContentItem>(
    `SELECT id, company_id, snapshot_id, type, title, body, provenance, disclosure, blob_ref, status,
            to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM content_items WHERE id = $1`, [id],
  );
  return rows[0] ?? null;
}

export interface ContentListRow { id: string; company_id: string; ticker: string | null; legal_name: string; type: ContentType; title: string; created_at: string }

export async function listContent(companyId?: string): Promise<ContentListRow[]> {
  const { rows } = await query<ContentListRow>(
    `SELECT ci.id, ci.company_id, c.primary_ticker AS ticker, c.legal_name, ci.type, ci.title,
            to_char(ci.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM content_items ci JOIN companies c ON c.id = ci.company_id
      ${companyId ? "WHERE ci.company_id = $1" : ""} ORDER BY ci.created_at DESC LIMIT 100`,
    companyId ? [companyId] : [],
  );
  return rows;
}
