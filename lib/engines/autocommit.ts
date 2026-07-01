/**
 * Auto-commit (Workstream C) — the desk replaces the manual §8 approval. Given a freshly-written
 * snapshot and the deepening outcome, it either (a) auto-writes a `thesis_approvals` row
 * (approved_by='desk') and flips the company to `published`, then enqueues the content spider, or
 * (b) — when the desk never cleared the bar and the owner policy holds below-bar work — leaves the
 * asset at `in_review` for the admin console (the residual soft gate).
 *
 * PURE: all side-effects (DB, queue) are injected, so it is deterministic in tests. Runs AFTER the
 * snapshot transaction commits — it never holds the append-only snapshot tx open across enqueue.
 */
import { query as dbQuery } from "../db/pool";
import { bossQueue } from "../queue/boss";
import { JOB, type JobName, type EnqueueOptions } from "../queue/types";
import { DESK_CONFIG, type DeskConfig } from "../config/desk";

export interface DeepenSummary {
  cleared: boolean;
  publishedBelowBar: boolean;
  finalConfidence: number;
  rounds: number;
  stoppedReason: string;
  noteLines: string[];
}

export interface AutoCommitInput {
  companyId: string;
  snapshotId: string;
  deepen: DeepenSummary;
  config?: DeskConfig;
}

export interface AutoCommitDeps {
  query?: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  enqueue?: (name: JobName, data: Record<string, unknown>, opts?: EnqueueOptions) => Promise<string | null>;
}

export interface AutoCommitResult {
  committed: boolean;
  approvalWritten: boolean;
  status: "published" | "in_review";
  jobId: string | null;
  reason: string;
}

// Publish only advances from a not-yet-live state (never re-publishes/loops a live asset).
const ADVANCEABLE = "('in_research','in_review','queued','watchlist')";
// A below-bar re-coverage of an ALREADY-live asset must actively demote it to in_review — its newest
// snapshot is unvetted and the consumer surface reads the latest, so a stale 'published' label would
// keep an unapproved thesis on /c and atop the feed. Everything but 'archived' is demotable.
const DEMOTABLE = "('in_research','in_review','queued','watchlist','published','monitoring')";

export async function autoCommit(input: AutoCommitInput, deps: AutoCommitDeps = {}): Promise<AutoCommitResult> {
  const q = deps.query ?? dbQuery;
  const enqueue = deps.enqueue ?? bossQueue.enqueue;
  const cfg = input.config ?? DESK_CONFIG;
  const { companyId, snapshotId, deepen } = input;

  const shouldCommit = deepen.cleared || deepen.publishedBelowBar;

  if (!shouldCommit) {
    // Below bar: rest at in_review for the admin console — and DEMOTE a previously-live asset, since
    // its latest snapshot is now unvetted.
    await q(
      `UPDATE companies SET coverage_status='in_review', coverage=jsonb_set(coverage,'{status}','"in_review"')
         WHERE id=$1 AND coverage_status IN ${DEMOTABLE}`,
      [companyId],
    );
    return { committed: false, approvalWritten: false, status: "in_review", jobId: null, reason: "below_bar_hold" };
  }

  const note = [
    `desk auto-approval · confidence ${(deepen.finalConfidence * 100).toFixed(0)}% · ${deepen.rounds} round(s) · ${deepen.stoppedReason}` +
      (deepen.publishedBelowBar ? " · PUBLISHED BELOW BAR" : ""),
    ...deepen.noteLines,
  ].join("\n").slice(0, 2000);

  // Idempotent, and never clobbers an operator edit or resurrects a vetoed row (DO NOTHING).
  const appr = await q(
    `INSERT INTO thesis_approvals (snapshot_id, company_id, approved_by, note, status)
     VALUES ($1,$2,'desk',$3,'approved')
     ON CONFLICT (snapshot_id) DO NOTHING`,
    [snapshotId, companyId, note],
  );
  const approvalWritten = (appr.rowCount ?? 0) > 0;

  // Downgrade-safe publish.
  await q(
    `UPDATE companies SET coverage_status=$2, coverage=jsonb_set(coverage,'{status}',$3::jsonb)
       WHERE id=$1 AND coverage_status IN ${ADVANCEABLE}`,
    [companyId, cfg.publishStatus, JSON.stringify(cfg.publishStatus)],
  );

  // Enqueue the content spider AFTER the approval is durably committed, so the worker sees it.
  let jobId: string | null = null;
  try {
    jobId = await enqueue(JOB.GENERATE_CONTENT, { company_id: companyId, snapshot_id: snapshotId }, { singletonKey: `content:${snapshotId}` });
  } catch (e) {
    console.warn(`[autocommit] enqueue GENERATE_CONTENT failed: ${(e as Error).message}`);
  }

  return { committed: true, approvalWritten, status: "published", jobId, reason: deepen.publishedBelowBar ? "published_below_bar" : "committed" };
}
