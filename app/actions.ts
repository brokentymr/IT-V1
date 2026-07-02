"use server";
/**
 * Operator-console control surface (Phase 5). Server Actions invoked by the screen forms — they
 * reuse the engines we already have. Mutations revalidate the affected screens; "run coverage"
 * ENQUEUES the existing job (owner decision: enqueue + watch on Jobs) rather than blocking.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query, withTransaction } from "../lib/db/pool";
import { ingestCompany } from "../lib/engines/ingestion";
import { SecAdapter } from "../lib/sources/sec";
import { bossQueue, cancelCompanyJobs } from "../lib/queue/boss";
import { JOB } from "../lib/queue/types";
import { FUNDAMENTALS_CONFIG } from "../lib/config/fundamentals";
import { CostCeilingError } from "../lib/llm/client";
import { answerCompanyChat, recordDeepenTurn } from "../lib/engines/company_chat";
import { retractClaim as retractClaimNode, retractFact as retractFactNode } from "../lib/engines/claim_dag";

export async function addCompany(formData: FormData): Promise<void> {
  const ticker = String(formData.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return;
  const res = await ingestCompany(ticker);
  // Auto-on-add: build clarity automatically (level-up B).
  await bossQueue.enqueue(JOB.ONBOARD_ASSET, { company_id: res.company_id }, { singletonKey: `onboard:${res.company_id}` }).catch(() => null);
  revalidatePath("/universe");
  redirect(`/company/${res.company_id}`);
}

/** Delete a company entirely: stop any in-flight/queued processing, then remove it. Every dependent
 *  table (snapshots, filings, content, onboarding runs, approvals, chats, areas, relationships,
 *  embeddings…) is ON DELETE CASCADE, so one delete cleans the whole record. Irreversible — the UI
 *  button confirms first. */
export async function deleteCompany(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  if (!companyId) return;
  // 1. Cancel pending/active queue jobs so nothing keeps processing a company we're about to delete.
  await cancelCompanyJobs(companyId).catch(() => 0);
  // 2. Remove the company; ON DELETE CASCADE removes all dependent rows. canonical_snapshots is
  //    append-only (forbid_mutation trigger), so we opt this one transaction into an authorized purge
  //    (migration 0017) — scoped to this delete, nothing else can delete a snapshot.
  await withTransaction(async (client) => {
    await client.query("SET LOCAL app.allow_purge = 'on'");
    await client.query("DELETE FROM companies WHERE id = $1", [companyId]);
  });
  revalidatePath("/universe");
  revalidatePath("/");
  redirect("/universe");
}

/** Resolve the latest covered filing from EDGAR and enqueue a coverage pass for it. */
export async function runCoverage(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const { rows } = await query<{ cik: string | null }>("SELECT cik FROM companies WHERE id = $1", [companyId]);
  const cik = rows[0]?.cik;
  if (!cik) return;
  const filings = await new SecAdapter().recentFilings(cik, { forms: FUNDAMENTALS_CONFIG.triggerForms });
  const latest = filings.data?.find((f) => /^10-[KQ]$/.test(f.form)) ?? filings.data?.[0];
  if (!latest) return;
  await bossQueue.enqueue(JOB.COVERAGE_PASS, {
    company_id: companyId, accession: latest.accession, form_type: latest.form, filing_url: latest.url,
  }, { singletonKey: `coverage:${companyId}:${latest.accession}` });
  revalidatePath(`/company/${companyId}`);
  redirect("/jobs");
}

/** Build/refresh the Perplexity research profile for a private / pre-IPO name. */
export async function runProfile(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  if (!companyId) return;
  await bossQueue.enqueue(JOB.PROFILE_PASS, { company_id: companyId }, { singletonKey: `profile:${companyId}` });
  revalidatePath(`/company/${companyId}`);
  redirect("/jobs");
}

/** Enroll/unenroll the asset in the automated analytics pipeline (daily monitor + filing poll). */
export async function setAnalytics(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const on = String(formData.get("on") ?? "") === "1";
  await query(
    `UPDATE companies SET coverage_status = $2,
            coverage = jsonb_set(coverage, '{status}', to_jsonb($2::text)) WHERE id = $1`,
    [companyId, on ? "monitoring" : "watchlist"],
  );
  revalidatePath(`/company/${companyId}`);
}

/** Enroll/unenroll in the content pipeline (a flag Phase 8 consumes). */
export async function setContent(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const on = String(formData.get("on") ?? "") === "1";
  await query(
    "UPDATE companies SET content_enrolled = $2, coverage = jsonb_set(coverage, '{content_enrolled}', to_jsonb($2::boolean)) WHERE id = $1",
    [companyId, on],
  );
  revalidatePath(`/company/${companyId}`);
}

/** The human checkpoint: approve (and optionally edit) the latest thesis. */
export async function approveThesis(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const snapshotId = String(formData.get("snapshot_id") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  const oneLiner = String(formData.get("one_liner") ?? "").trim();
  const longForm = String(formData.get("long_form") ?? "").trim();
  const edited = oneLiner || longForm ? { one_liner: oneLiner || null, long_form: longForm || null } : null;
  if (!snapshotId) return;
  // Operator approval overrides any desk auto-approval and re-labels the audit trail to 'operator'.
  await query(
    `INSERT INTO thesis_approvals (snapshot_id, company_id, approved_by, edited_thesis, note, status)
     VALUES ($1,$2,'operator',$3,$4,'approved')
     ON CONFLICT (snapshot_id) DO UPDATE SET approved_at = now(), approved_by = 'operator',
       edited_thesis = EXCLUDED.edited_thesis, note = EXCLUDED.note, status = 'approved'`,
    [snapshotId, companyId, edited ? JSON.stringify(edited) : null, note],
  );
  // Approving the below-bar hold commits it: publish (downgrade-safe) + build the content spider.
  await query(
    `UPDATE companies SET coverage_status='published', coverage=jsonb_set(coverage,'{status}','"published"')
       WHERE id=$1 AND coverage_status IN ('in_research','in_review','queued','watchlist')`,
    [companyId],
  );
  await bossQueue.enqueue(JOB.GENERATE_CONTENT, { company_id: companyId, snapshot_id: snapshotId }, { singletonKey: `content:${snapshotId}` }).catch(() => null);
  revalidatePath(`/company/${companyId}`);
}

/** Admin veto: mark the approval vetoed, pull any published content, and drop the asset back to review.
 *  The consumer surface refuses to render a vetoed snapshot, so this actually retracts it. */
export async function vetoThesis(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const snapshotId = String(formData.get("snapshot_id") ?? "");
  if (!snapshotId) return;
  await query("UPDATE thesis_approvals SET status='vetoed' WHERE snapshot_id=$1", [snapshotId]);
  await query("UPDATE content_items SET suppressed=true WHERE snapshot_id=$1", [snapshotId]);
  await query(`UPDATE companies SET coverage_status='in_review', coverage=jsonb_set(coverage,'{status}','"in_review"') WHERE id=$1`, [companyId]);
  revalidatePath(`/company/${companyId}`);
  revalidatePath(`/c/${companyId}`);
}

/** Control P4: operator retracts ONE claim (a single narrative statement) — flips it to 'retracted'. */
export async function retractClaim(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const claimId = String(formData.get("claim_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || "operator retraction";
  if (!claimId) return;
  await retractClaimNode(claimId, reason).catch(() => false);
  if (companyId) {
    revalidatePath(`/company/${companyId}`);
    revalidatePath(`/c/${companyId}`);
  }
}

/** Control P4: operator retracts a FACT — flips it to 'retracted' and stales every dependent claim. */
export async function retractFact(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const snapshotId = String(formData.get("snapshot_id") ?? "");
  const factKey = String(formData.get("fact_key") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || "operator retraction";
  if (!snapshotId || !factKey) return;
  await retractFactNode({ snapshotId, factKey, reason }).catch(() => 0);
  if (companyId) {
    revalidatePath(`/company/${companyId}`);
    revalidatePath(`/c/${companyId}`);
  }
}

/** Admin rollback: pull the published content pack from the consumer surface but keep the asset under
 *  monitoring (the thesis stays approved; this just retracts the consumables). */
export async function rollbackPublish(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const snapshotId = String(formData.get("snapshot_id") ?? "");
  if (!snapshotId) return;
  await query("UPDATE content_items SET suppressed=true WHERE snapshot_id=$1", [snapshotId]);
  await query(`UPDATE companies SET coverage_status='monitoring', coverage=jsonb_set(coverage,'{status}','"monitoring"') WHERE id=$1 AND coverage_status='published'`, [companyId]);
  revalidatePath(`/company/${companyId}`);
  revalidatePath(`/c/${companyId}`);
}

/** Per-report chat: grounded Q&A over the company's canonical research. A budget breach leaves the
 *  user's turn persisted and surfaces quietly rather than throwing to the user. */
export async function sendCompanyChat(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const message = String(formData.get("message") ?? "").trim();
  if (!companyId || !message) return;
  try {
    await answerCompanyChat({ companyId, message });
  } catch (e) {
    if (!(e instanceof CostCeilingError)) throw e; // ceiling: user turn is already saved; degrade quietly
  }
  revalidatePath(`/company/${companyId}`);
}

/** "Deepen research now": union the user's focus into the company's standing research focus and
 *  re-run coverage (listed) or the research profile (unlisted) with that focus. */
export async function deepenNow(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  if (!companyId) return;
  const focus = String(formData.get("focus") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (focus.length) {
    const cur = await query<{ rf: string[] }>("SELECT COALESCE(coverage->'research_focus','[]') AS rf FROM companies WHERE id = $1", [companyId]);
    const merged = [...new Set([...(cur.rows[0]?.rf ?? []), ...focus])];
    await query("UPDATE companies SET coverage = jsonb_set(coverage,'{research_focus}',$2::jsonb) WHERE id = $1", [companyId, JSON.stringify(merged)]);
  }

  const { rows } = await query<{ cik: string | null }>("SELECT cik FROM companies WHERE id = $1", [companyId]);
  const cik = rows[0]?.cik;
  let jobId: string | null = null;
  if (cik) {
    const filings = await new SecAdapter().recentFilings(cik, { forms: FUNDAMENTALS_CONFIG.triggerForms });
    const latest = filings.data?.find((f) => /^10-[KQ]$/.test(f.form)) ?? filings.data?.[0];
    if (latest) {
      jobId = await bossQueue.enqueue(JOB.COVERAGE_PASS, {
        company_id: companyId, accession: latest.accession, form_type: latest.form, filing_url: latest.url, focus_override: focus,
      }, { singletonKey: `coverage:${companyId}:${latest.accession}` }).catch(() => null);
    }
  } else {
    jobId = await bossQueue.enqueue(JOB.PROFILE_PASS, { company_id: companyId }, { singletonKey: `profile:${companyId}` }).catch(() => null);
  }
  await recordDeepenTurn({ companyId, focus, enqueuedJobId: jobId });
  revalidatePath(`/company/${companyId}`);
  redirect("/jobs");
}

export async function addLink(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const toTicker = String(formData.get("to_ticker") ?? "").trim().toUpperCase();
  const type = String(formData.get("type") ?? "competitor");
  if (!toTicker) return;
  const to = await query<{ id: string; gics_sector: string | null }>(
    "SELECT id, gics_sector FROM companies WHERE upper(primary_ticker) = $1", [toTicker],
  );
  const from = await query<{ gics_sector: string | null }>("SELECT gics_sector FROM companies WHERE id = $1", [companyId]);
  const target = to.rows[0];
  if (!target || target.id === companyId) return;
  const crossSector = !!from.rows[0]?.gics_sector && !!target.gics_sector && from.rows[0].gics_sector !== target.gics_sector;
  await query(
    `INSERT INTO company_links (from_company_id, to_company_id, type, cross_sector, strength, status)
     VALUES ($1,$2,$3,$4,'medium','active') ON CONFLICT (from_company_id, to_company_id, type) DO NOTHING`,
    [companyId, target.id, type, crossSector],
  );
  revalidatePath(`/company/${companyId}`);
}

export async function setLinkStatus(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const linkId = String(formData.get("link_id") ?? "");
  const status = String(formData.get("status") ?? "active");
  await query("UPDATE company_links SET status = $2 WHERE id = $1", [linkId, status]);
  revalidatePath(`/company/${companyId}`);
}

export async function deleteLink(formData: FormData): Promise<void> {
  const companyId = String(formData.get("company_id") ?? "");
  const linkId = String(formData.get("link_id") ?? "");
  await query("DELETE FROM company_links WHERE id = $1", [linkId]);
  revalidatePath(`/company/${companyId}`);
}
