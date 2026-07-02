import { randomUUID } from "node:crypto";
import { withTransaction } from "../db/pool";
import { verifyHmac } from "./verify";
import { resolveCompanyId } from "./resolve";
import { bossQueue } from "../queue/boss";
import { JOB } from "../queue/types";
import { putObject } from "../storage/spaces";
import { SecAdapter } from "../sources/sec";
import type { BlobStore, Queue, WebhookStatus } from "./types";

const defaultStore: BlobStore = { put: (k, b, c) => putObject(k, b, c) };

export interface FilingResult {
  status: WebhookStatus;
  raw_document_id?: string;
  company_id?: string;
  job_id?: string | null;
}

/**
 * Process a filing-arrival webhook (spec §9.2). Authenticates via HMAC-SHA256, archives the
 * raw payload to Spaces, writes a raw_document + provenance, enqueues a coverage-pass job
 * (Engine 2, Phase 4), and is idempotent on the filing accession number.
 */
export async function processFilingWebhook(
  rawBody: string,
  signature: string | null | undefined,
  opts: { store?: BlobStore; queue?: Queue } = {},
): Promise<FilingResult> {
  const secret = process.env.FILING_WEBHOOK_SECRET;
  if (!secret || !verifyHmac(rawBody, signature, secret)) return { status: "unauthorized" };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: "bad_request" };
  }

  const accession = typeof payload.accession === "string" ? payload.accession : null;
  const formType =
    typeof payload.form_type === "string" ? payload.form_type
      : typeof payload.formType === "string" ? payload.formType : null;
  let filingUrl =
    typeof payload.filing_url === "string" ? payload.filing_url
      : typeof payload.url === "string" ? payload.url : null;
  const filedAt = typeof payload.filed_at === "string" ? payload.filed_at : new Date().toISOString();
  if (!accession) return { status: "bad_request" };

  // Senders don't always include the primary-document URL. Recover it from the accession before we
  // write provenance + enqueue coverage — without it the coverage pass runs quant-only (no MD&A
  // drivers, no forward scenario). Best-effort; the coverage pass also backstops this from the DB CIK.
  if (!filingUrl && typeof payload.cik === "string" && payload.cik) {
    filingUrl = await new SecAdapter().primaryDocUrl(payload.cik, accession).catch(() => null);
  }

  const store = opts.store ?? defaultStore;
  const queue = opts.queue ?? bossQueue;
  const blobKey = `filings/${accession}.json`;

  const outcome = await withTransaction(async (client): Promise<FilingResult> => {
    const companyId = await resolveCompanyId(client, {
      ticker: payload.ticker as string | undefined,
      cik: payload.cik as string | undefined,
    });
    if (!companyId) return { status: "unknown_company" };

    const delivered = await client.query(
      `INSERT INTO webhook_deliveries (source, idempotency_key, company_id, payload)
       VALUES ('filing', $1, $2, $3) ON CONFLICT (source, idempotency_key) DO NOTHING RETURNING id`,
      [accession, companyId, payload],
    );
    if (delivered.rowCount === 0) return { status: "duplicate", company_id: companyId };

    // Archive the raw payload inside the transaction; a storage failure rolls back the delivery.
    await store.put(blobKey, rawBody, "application/json");

    const docId = randomUUID();
    await client.query(
      `INSERT INTO raw_documents (id, company_id, kind, received_at, source, blob_ref, metadata)
       VALUES ($1, $2, 'filing', $3, 'SEC EDGAR', $4, $5)`,
      [docId, companyId, filedAt, blobKey, { accession, form_type: formType, url: filingUrl }],
    );
    await client.query(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title, blob_ref, retrieved_at, metadata)
       VALUES ($1, 1, 'filing', 'SEC EDGAR', $2, $3, $4, now(), $5)`,
      [companyId, filingUrl, `${formType ?? "Filing"} ${accession}`, blobKey, { accession }],
    );
    return { status: "ok", raw_document_id: docId, company_id: companyId };
  });

  if (outcome.status !== "ok") return outcome;

  // Enqueue the coverage pass after the filing is durably committed.
  const jobId = await queue.enqueue(JOB.COVERAGE_PASS, {
    company_id: outcome.company_id,
    accession,
    form_type: formType,
    filing_url: filingUrl,
  }, { singletonKey: `coverage:${outcome.company_id}:${accession}` }); // dedupe webhook+poll for one filing
  return { ...outcome, job_id: jobId };
}
