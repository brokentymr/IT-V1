/**
 * Calendar read model (Phase 6, spec §9.6). The planning surface keyed to known filing dates: every
 * covered listed asset's next earnings date, with coverage status, whether a forward pass is already
 * staged, content enrollment, and the count of open areas of interest waiting on that filing.
 */
import { query } from "../db/pool";

export interface CalendarEvent {
  company_id: string;
  ticker: string | null;
  legal_name: string;
  date: string; // YYYY-MM-DD
  coverage_status: string;
  content_enrolled: boolean;
  conviction: number | null;
  forward_staged: boolean;
  open_areas: number;
}

/** Earnings events across the universe within [from, to] (inclusive), ordered by date. */
export async function listCalendar(opts: { from: string; to: string }): Promise<CalendarEvent[]> {
  const { rows } = await query<CalendarEvent>(
    `SELECT c.id AS company_id, c.primary_ticker AS ticker, c.legal_name,
            to_char(c.next_earnings_date,'YYYY-MM-DD') AS date,
            c.coverage_status, c.content_enrolled, s.conviction,
            (cf.current_events->'forward_note'->>'next_earnings_date' = to_char(c.next_earnings_date,'YYYY-MM-DD')) AS forward_staged,
            (SELECT count(*) FROM areas_of_interest a WHERE a.company_id = c.id AND a.status <> 'resolved')::int AS open_areas
       FROM companies c
       LEFT JOIN canonical_files cf ON cf.company_id = c.id
       LEFT JOIN LATERAL (
         SELECT conviction FROM canonical_snapshots cs
          WHERE cs.company_id = c.id ORDER BY cs.as_of DESC, cs.created_at DESC LIMIT 1
       ) s ON true
      WHERE c.next_earnings_date IS NOT NULL
        AND c.next_earnings_date >= $1::date AND c.next_earnings_date <= $2::date
      ORDER BY c.next_earnings_date, c.legal_name`,
    [opts.from, opts.to],
  );
  return rows.map((r) => ({ ...r, forward_staged: r.forward_staged ?? false }));
}
