/**
 * Areas of Interest (Phase 5.5). The connective tissue between the daily News Monitor (Engine 3) and
 * the filing-triggered analyst desk (Engine 2):
 *
 *   accumulate  — every material/major news note opens or accumulates onto an area, clustered by
 *                 theme (the news category). Repeat headlines on one theme pile onto one area, so a
 *                 company that suddenly owns the headlines across several themes shows several open
 *                 areas — the cluster is legible at a glance.
 *   loadOpen    — the coverage pass pulls the open areas so the desk reasons over them explicitly.
 *   applyResolutions — the desk's verdict resolves the areas it can put to bed (or carries them to
 *                 next quarter). Mutable status; the append-only snapshots are never touched.
 */
import { query } from "../db/pool";

/** The desk's adjudication vocabulary. The first three RESOLVE an area; carry_forward keeps it open
 *  but tagged for next quarter; leave_open means this filing didn't speak to it. */
export const RESOLUTION_VERDICTS = ["invalidated", "confirmed", "overreaction", "carry_forward", "leave_open"] as const;
export type ResolutionVerdict = (typeof RESOLUTION_VERDICTS)[number];

export interface OpenArea {
  id: string;
  theme: string;
  title: string;
  summary: string;
  category: string;
  band: string;
  score: number;
  mentions: number;
  status: string;
}

/** Open or accumulate an area of interest from a (material/major) news note. */
export async function accumulateArea(input: {
  companyId: string;
  category: string;
  band: "material" | "major";
  score: number;
  headline: string;
  url: string | null;
  summary: string;
  detectedAt?: string;
}): Promise<{ id: string; created: boolean }> {
  const theme = input.category;
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  const headlineEntry = JSON.stringify([{ headline: input.headline, url: input.url, detected_at: detectedAt, score: input.score }]);

  const { rows } = await query<{ id: string; created: boolean }>(
    `INSERT INTO areas_of_interest (company_id, theme, title, summary, category, band, score, mentions, headlines, status)
     VALUES ($1,$2,$3,$4,$2,$5,$6,1,$7::jsonb,'open')
     ON CONFLICT (company_id, theme) WHERE status <> 'resolved'
     DO UPDATE SET
       mentions   = areas_of_interest.mentions + 1,
       title      = EXCLUDED.title,
       summary    = EXCLUDED.summary,
       score      = GREATEST(areas_of_interest.score, EXCLUDED.score),
       band       = CASE WHEN EXCLUDED.band = 'major' OR areas_of_interest.band = 'major' THEN 'major' ELSE 'material' END,
       headlines  = areas_of_interest.headlines || EXCLUDED.headlines,
       updated_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [input.companyId, theme, input.headline, input.summary, input.band, input.score, headlineEntry],
  );
  return rows[0];
}

/** Open + carried-forward areas for a company, hottest first (the desk's adjudication queue). */
export async function loadOpenAreas(companyId: string): Promise<OpenArea[]> {
  const { rows } = await query<OpenArea>(
    `SELECT id, theme, title, summary, category, band, score, mentions, status
       FROM areas_of_interest
      WHERE company_id = $1 AND status <> 'resolved'
      ORDER BY score DESC, updated_at DESC`,
    [companyId],
  );
  return rows;
}

/** Set/refresh an area's summary (e.g. the price-move attribution explanation). */
export async function annotateArea(id: string, summary: string): Promise<void> {
  await query("UPDATE areas_of_interest SET summary = $2, updated_at = now() WHERE id = $1", [id, summary]);
}

/** Apply an adjudication: resolve / carry-forward the open areas ruled on. The resolver may be a
 *  filing (accession + snapshotId) or a price move (accession = "price:<date>", snapshotId = null). */
export async function applyResolutions(opts: {
  companyId: string;
  accession: string;
  snapshotId: string | null;
  revisitAfter: string | null;
  resolutions: Array<{ theme: string; verdict: ResolutionVerdict; note: string }>;
}): Promise<{ resolved: number; carried: number }> {
  let resolved = 0;
  let carried = 0;
  for (const r of opts.resolutions) {
    if (r.verdict === "leave_open") continue;
    if (r.verdict === "carry_forward") {
      const res = await query(
        `UPDATE areas_of_interest
            SET status = 'carried_forward', disposition = 'carried_forward', resolution_note = $3,
                revisit_after = $4, updated_at = now()
          WHERE company_id = $1 AND theme = $2 AND status <> 'resolved'`,
        [opts.companyId, r.theme, r.note, opts.revisitAfter],
      );
      carried += res.rowCount ?? 0;
    } else {
      const res = await query(
        `UPDATE areas_of_interest
            SET status = 'resolved', disposition = $3, resolution_note = $4, resolved_at = now(),
                resolved_by_accession = $5, resolved_by_snapshot = $6, updated_at = now()
          WHERE company_id = $1 AND theme = $2 AND status <> 'resolved'`,
        [opts.companyId, r.theme, r.verdict, r.note, opts.accession, opts.snapshotId],
      );
      resolved += res.rowCount ?? 0;
    }
  }
  return { resolved, carried };
}
