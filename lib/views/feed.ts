/**
 * Consumer feed read model (level-up A). The swipe-first home: one clean card per company — the
 * one-liner, human status, and the crowd-vs-fundamentals read. No tables, no jargon.
 */
import { query } from "../db/pool";

export interface FeedCard {
  id: string;
  ticker: string | null;
  legal_name: string;
  sector: string | null;
  coverage_status: string;
  one_liner: string | null;
  conviction: number | null;
  gap_direction: string | null;
  has_content: boolean;
}

export async function listFeed(): Promise<FeedCard[]> {
  const { rows } = await query<FeedCard>(
    `SELECT c.id, c.primary_ticker AS ticker, c.legal_name, c.gics_sector AS sector, c.coverage_status,
            s.content->'thesis'->>'one_liner' AS one_liner, s.conviction,
            cf.current_events->'brand_sentiment'->'sentiment_vs_fundamentals_gap'->>'direction' AS gap_direction,
            EXISTS (SELECT 1 FROM content_items ci WHERE ci.company_id = c.id) AS has_content
       FROM companies c
       LEFT JOIN canonical_files cf ON cf.company_id = c.id
       LEFT JOIN LATERAL (
         SELECT content, conviction FROM canonical_snapshots cs
          WHERE cs.company_id = c.id ORDER BY cs.as_of DESC, cs.created_at DESC LIMIT 1
       ) s ON true
      ORDER BY (c.coverage_status = 'in_review') DESC, c.legal_name`,
    [],
  );
  return rows;
}
