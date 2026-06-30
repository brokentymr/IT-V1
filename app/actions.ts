"use server";
/**
 * Operator-console control surface (Phase 5). Server Actions invoked by the screen forms — they
 * reuse the engines we already have. Mutations revalidate the affected screens; "run coverage"
 * ENQUEUES the existing job (owner decision: enqueue + watch on Jobs) rather than blocking.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { query } from "../lib/db/pool";
import { ingestCompany } from "../lib/engines/ingestion";
import { SecAdapter } from "../lib/sources/sec";
import { bossQueue } from "../lib/queue/boss";
import { JOB } from "../lib/queue/types";
import { FUNDAMENTALS_CONFIG } from "../lib/config/fundamentals";

export async function addCompany(formData: FormData): Promise<void> {
  const ticker = String(formData.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return;
  const res = await ingestCompany(ticker);
  revalidatePath("/universe");
  redirect(`/company/${res.company_id}`);
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
  });
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
  await query(
    `INSERT INTO thesis_approvals (snapshot_id, company_id, edited_thesis, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (snapshot_id) DO UPDATE SET approved_at = now(), edited_thesis = EXCLUDED.edited_thesis, note = EXCLUDED.note`,
    [snapshotId, companyId, edited ? JSON.stringify(edited) : null, note],
  );
  revalidatePath(`/company/${companyId}`);
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
