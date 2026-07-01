/**
 * GENERATE_CONTENT job handler (Workstream C auto-commit). Builds the content spider from a
 * desk-approved snapshot, out of band from the coverage transaction. Idempotent: a complete set for
 * the snapshot is a no-op on retry; a partial set from a failed run is cleared and rebuilt cleanly.
 * A veto landing between enqueue and run surfaces as NotApprovedError and is swallowed (no retry storm).
 */
import { query } from "../db/pool";
import { generateSpider } from "../content/generate";
import { NotApprovedError } from "../content/assemble";

export interface ContentJobData { company_id: string; snapshot_id?: string }

export interface ContentJobResult { built: boolean; skipped?: boolean; suppressed?: boolean; deckId?: string; newsletterId?: string; shortformId?: string }

const SPIDER_TYPES = ["deck", "newsletter", "shortform"] as const;

export async function handleGenerateContent(data: ContentJobData): Promise<ContentJobResult> {
  const snapshotId = data.snapshot_id ?? null;

  if (snapshotId) {
    const existing = await query<{ type: string }>(
      "SELECT type FROM content_items WHERE snapshot_id = $1 AND suppressed = false AND type = ANY($2)",
      [snapshotId, SPIDER_TYPES as unknown as string[]],
    );
    const have = new Set(existing.rows.map((r) => r.type));
    if (SPIDER_TYPES.every((t) => have.has(t))) return { built: false, skipped: true }; // already generated
    if (have.size) {
      // Partial set from a prior failed run — clear it so we regenerate exactly one clean set.
      await query("DELETE FROM content_items WHERE snapshot_id = $1 AND suppressed = false AND type = ANY($2)", [snapshotId, SPIDER_TYPES as unknown as string[]]);
    }
  }

  try {
    const r = await generateSpider(data.company_id, {}, snapshotId ?? undefined);
    return { built: true, deckId: r.deckId, newsletterId: r.newsletterId, shortformId: r.shortformId };
  } catch (e) {
    if (e instanceof NotApprovedError) return { built: false, suppressed: true }; // vetoed after enqueue
    throw e; // transient (e.g. cost ceiling) — let pg-boss retry
  }
}
