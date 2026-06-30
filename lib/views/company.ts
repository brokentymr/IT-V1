/**
 * Company read model (Phase 5, spec §7.3). Assembles the canonical file as the screen renders it:
 * identity → latest snapshot (fundamentals · thesis · Monte Carlo scenario · market context) →
 * relationships + the read-throughs that traveled them → current-events feed → signals → history.
 */
import { query } from "../db/pool";

export interface CompanyHeader {
  id: string;
  legal_name: string;
  primary_ticker: string | null;
  cik: string | null;
  gics_sector: string | null;
  sub_industry: string | null;
  coverage_status: string;
  listing: string;
  content_enrolled: boolean;
  next_earnings_date: string | null;
  tradingview_symbol: string | null;
  positions_held: unknown[];
  research_focus: string[];
  rolling_outlook: string;
  forward_note: Record<string, unknown> | null;
}

export interface SnapshotRow {
  snapshot_id: string;
  as_of: string;
  cycle_label: string;
  trigger: string;
  conviction: number | null;
  filing_ref: string | null;
  content: Record<string, unknown>;
  diff: Record<string, unknown>;
  created_at: string;
}

export interface RelationshipRow {
  id: string;
  to_company_id: string;
  to_name: string;
  to_ticker: string | null;
  to_sector: string | null;
  type: string;
  cross_sector: boolean;
  strength: string;
  status: string;
  direction_note: string | null;
  rationale: string | null;
  readthrough_count: number;
}

export interface FeedNote {
  id: string;
  detected_at: string;
  headline: string;
  summary: string | null;
  category: string;
  origin_kind: string;
  importance_score: number;
  status: string;
  origin_company_id: string | null;
}

export interface CompanyDetail {
  header: CompanyHeader;
  latest: SnapshotRow | null;
  snapshots: Array<{ snapshot_id: string; as_of: string; cycle_label: string; conviction: number | null }>;
  approval: { approved_at: string; approved_by: string; edited_thesis: unknown; note: string | null } | null;
  relationships: RelationshipRow[];
  feed: FeedNote[];
  signals: Array<{ ts: string; kind: string; payload: Record<string, unknown> }>;
}

export async function getCompanyDetail(id: string): Promise<CompanyDetail | null> {
  const c = await query<CompanyHeader & { current_events: { rolling_outlook?: string; forward_note?: Record<string, unknown> } }>(
    `SELECT c.id, c.legal_name, c.primary_ticker, c.cik, c.gics_sector, c.sub_industry,
            c.coverage_status, c.listing, c.content_enrolled, c.tradingview_symbol,
            to_char(c.next_earnings_date,'YYYY-MM-DD') AS next_earnings_date,
            COALESCE(c.coverage->'positions_held','[]') AS positions_held,
            COALESCE(c.coverage->'research_focus','[]') AS research_focus,
            COALESCE(cf.current_events,'{}') AS current_events
       FROM companies c
       LEFT JOIN canonical_files cf ON cf.company_id = c.id
      WHERE c.id = $1`,
    [id],
  );
  if (!c.rows[0]) return null;
  const row = c.rows[0];
  const header: CompanyHeader = {
    id: row.id, legal_name: row.legal_name, primary_ticker: row.primary_ticker, cik: row.cik,
    gics_sector: row.gics_sector, sub_industry: row.sub_industry, coverage_status: row.coverage_status,
    listing: row.listing, content_enrolled: row.content_enrolled, next_earnings_date: row.next_earnings_date,
    tradingview_symbol: row.tradingview_symbol, positions_held: (row.positions_held as unknown[]) ?? [],
    research_focus: (row.research_focus as string[]) ?? [],
    rolling_outlook: row.current_events?.rolling_outlook ?? "",
    forward_note: row.current_events?.forward_note ?? null,
  };

  const snaps = await query<SnapshotRow>(
    `SELECT snapshot_id, to_char(as_of,'YYYY-MM-DD') AS as_of, cycle_label, trigger, conviction, filing_ref,
            content, diff, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
       FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC`,
    [id],
  );
  const latest = snaps.rows[0] ?? null;

  const approval = latest
    ? (await query<{ approved_at: string; approved_by: string; edited_thesis: unknown; note: string | null }>(
        "SELECT to_char(approved_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS approved_at, approved_by, edited_thesis, note FROM thesis_approvals WHERE snapshot_id = $1",
        [latest.snapshot_id],
      )).rows[0] ?? null
    : null;

  const rels = await query<RelationshipRow>(
    `SELECT cl.id, cl.to_company_id, t.legal_name AS to_name, t.primary_ticker AS to_ticker, t.gics_sector AS to_sector,
            cl.type, cl.cross_sector, cl.strength, cl.status, cl.direction_note, cl.rationale,
            (SELECT count(*) FROM news_notes n WHERE n.company_id = cl.to_company_id AND n.origin_company_id = cl.from_company_id AND n.origin_kind = 'read_through')::int AS readthrough_count
       FROM company_links cl JOIN companies t ON t.id = cl.to_company_id
      WHERE cl.from_company_id = $1 ORDER BY cl.type, t.legal_name`,
    [id],
  );

  const feed = await query<FeedNote>(
    `SELECT id, to_char(detected_at,'YYYY-MM-DD"T"HH24:MI:SS') AS detected_at,
            content->>'headline' AS headline, content->>'summary' AS summary, category,
            origin_kind, importance_score, status, origin_company_id
       FROM news_notes WHERE company_id = $1 ORDER BY detected_at DESC LIMIT 30`,
    [id],
  );

  const signals = await query<{ ts: string; kind: string; payload: Record<string, unknown> }>(
    `SELECT to_char(ts,'YYYY-MM-DD"T"HH24:MI:SS') AS ts, kind, payload
       FROM signal_events WHERE company_id = $1 ORDER BY ts DESC LIMIT 10`,
    [id],
  );

  return {
    header, latest,
    snapshots: snaps.rows.map((s) => ({ snapshot_id: s.snapshot_id, as_of: s.as_of, cycle_label: s.cycle_label, conviction: s.conviction })),
    approval, relationships: rels.rows, feed: feed.rows, signals: signals.rows,
  };
}
