/**
 * Pipeline / Jobs read model (Phase 5, spec §7.3). The live operational picture: the pg-boss queue
 * (coverage + sentiment jobs), recent coverage snapshots, and the incoming alert + news feeds.
 */
import { query } from "../db/pool";

export interface JobRow {
  id: string;
  name: string;
  state: string;
  created_on: string;
  completed_on: string | null;
  ticker: string | null;
  accession: string | null;
  output: Record<string, unknown> | null;
}

export async function getJobs(limit = 25): Promise<JobRow[]> {
  const { rows } = await query<JobRow>(
    `SELECT j.id::text, j.name, j.state,
            to_char(j.created_on,'YYYY-MM-DD"T"HH24:MI:SS') AS created_on,
            to_char(j.completed_on,'YYYY-MM-DD"T"HH24:MI:SS') AS completed_on,
            c.primary_ticker AS ticker, j.data->>'accession' AS accession, j.output
       FROM pgboss.job j
       LEFT JOIN companies c ON c.id = (CASE WHEN j.data->>'company_id' ~ '^[0-9a-fA-F-]{36}$'
                                             THEN (j.data->>'company_id')::uuid END)
      ORDER BY j.created_on DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface RecentCoverage {
  snapshot_id: string;
  company_id: string;
  ticker: string | null;
  legal_name: string;
  cycle_label: string;
  conviction: number | null;
  as_of: string;
  created_at: string;
}

export async function getRecentCoverage(limit = 15): Promise<RecentCoverage[]> {
  const { rows } = await query<RecentCoverage>(
    `SELECT cs.snapshot_id, cs.company_id, c.primary_ticker AS ticker, c.legal_name, cs.cycle_label, cs.conviction,
            to_char(cs.as_of,'YYYY-MM-DD') AS as_of, to_char(cs.created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM canonical_snapshots cs JOIN companies c ON c.id = cs.company_id
      ORDER BY cs.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export interface FeedItem {
  kind: string;
  ticker: string | null;
  company_id: string;
  label: string;
  detail: string;
  ts: string;
  score?: number;
}

export async function getFeeds(): Promise<{ alerts: FeedItem[]; news: FeedItem[] }> {
  const alerts = await query<FeedItem>(
    `SELECT 'signal' AS kind, c.primary_ticker AS ticker, se.company_id, se.kind AS label,
            COALESCE(se.payload->>'symbol', se.payload->>'price', '') AS detail,
            to_char(se.ts,'YYYY-MM-DD"T"HH24:MI:SS') AS ts
       FROM signal_events se JOIN companies c ON c.id = se.company_id
      ORDER BY se.ts DESC LIMIT 15`,
  );
  const news = await query<FeedItem>(
    `SELECT n.origin_kind AS kind, c.primary_ticker AS ticker, n.company_id,
            n.content->>'headline' AS label, n.category AS detail,
            to_char(n.detected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS ts, n.importance_score AS score
       FROM news_notes n JOIN companies c ON c.id = n.company_id
      ORDER BY n.detected_at DESC LIMIT 20`,
  );
  return { alerts: alerts.rows, news: news.rows };
}
