/**
 * Engine — Claim dependency DAG + stale propagation (control P4).
 *
 * A FACT is a number/observation pulled from a source (an XBRL line item, a computed ratio, a driver
 * framing, a Monte-Carlo band, a lever, external context). A CLAIM is a narrative statement the desk
 * publishes (thesis one-liner, long form, a tension, an invalidation trigger, a key debate, a watch
 * item, a driver framing). Claims CONSUME facts. When a fact is corrected or retracted, every claim
 * that consumes it goes STALE; a hard accounting-identity failure retracts the implicated fact.
 *
 * The pure functions (catalogFacts / extractClaims / resolveEdges) derive the DAG from a snapshot's
 * append-only content; buildClaimDag / propagateRestatement / markFactCorrected / retractFact /
 * retractClaim persist the mutable status into the claim_dag tables (migration 0020). All side effects
 * go through lib/db/pool; nothing here uses RNG or wall-clock in its logic (only DEFAULT now() in SQL).
 */
import { query, withTransaction } from "../db/pool";
import { CLAIM_DAG_CONFIG, type ClaimDagConfig } from "../config/claim_dag";

// ---------------------------------------------------------------------------
// Loosely-typed view over the append-only snapshot content the DAG reads.
// ---------------------------------------------------------------------------
interface ProvEntry { claim_id?: string; source_ref?: string | null }
interface LineItemLike { label?: string; value?: number; unit?: string; period_end?: string | null }
interface ModelLike {
  period_end?: string | null;
  fiscal_period?: string | null;
  line_items?: Record<string, LineItemLike>;
  ratios?: Record<string, number>;
}
interface DriverLike { name?: string; metric?: string; framing?: string }
interface ScenarioBand { p10?: number; p50?: number; p90?: number }
interface DagContent {
  fundamentals?: { model?: ModelLike; provenance?: ProvEntry[] };
  hypotheses?: { drivers?: DriverLike[]; provenance?: ProvEntry[] };
  scenario?: { target_period?: string | null; bands?: Record<string, ScenarioBand>; watch_items?: string[]; provenance?: ProvEntry[] };
  levers?: Record<string, unknown>;
  market_context?: { provenance?: ProvEntry[] };
  // key_debates are typed objects (question/bull/bear/lean), not strings — see extractClaims.
  key_debates?: Array<string | { question?: string; bull?: string; bear?: string; lean?: string }>;
  thesis?: { one_liner?: string; long_form?: string; tensions?: string[]; invalidation_triggers?: string[] };
}

export interface FactDescriptor {
  fact_key: string;
  kind: string;
  source_ref: string | null;
  value_num: number | null;
  value_text: string | null;
  period: string | null;
}

export interface ClaimDescriptor {
  claim_kind: string;
  ordinal: number;
  text: string;
}

export interface ClaimDagCounts { facts: number; claims: number; edges: number }

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------
const slug = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "driver";

const firstRef = (prov?: ProvEntry[]): string | null => prov?.find((p) => p.source_ref)?.source_ref ?? null;

/** Derive the fact descriptors from a snapshot's content, attaching each fact's source_ref from the
 *  matching content provenance array (falling back to the filing source for computed figures). PURE. */
export function catalogFacts(content: DagContent): FactDescriptor[] {
  const facts: FactDescriptor[] = [];
  const model = content.fundamentals?.model;
  const filingRef = firstRef(content.fundamentals?.provenance);

  // fundamentals.<k> — XBRL line items (ground truth), each with its own provenance entry.
  const lineItems = model?.line_items ?? {};
  for (const [k, li] of Object.entries(lineItems)) {
    const specific = content.fundamentals?.provenance?.find((p) => p.claim_id === `fundamentals.${k}`)?.source_ref;
    facts.push({
      fact_key: `fundamentals.${k}`,
      kind: "fundamentals",
      source_ref: specific ?? filingRef,
      value_num: typeof li.value === "number" && Number.isFinite(li.value) ? li.value : null,
      value_text: li.label ?? null,
      period: li.period_end ?? model?.period_end ?? null,
    });
  }

  // ratio.<k> — derived margins (grounded to the same filing).
  for (const [k, v] of Object.entries(model?.ratios ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    facts.push({ fact_key: `ratio.${k}`, kind: "ratio", source_ref: filingRef, value_num: v, value_text: null, period: model?.period_end ?? null });
  }

  // driver.<slug> — MD&A drivers.
  const driverRef = firstRef(content.hypotheses?.provenance) ?? filingRef;
  for (const d of content.hypotheses?.drivers ?? []) {
    if (!d.name) continue;
    facts.push({ fact_key: `driver.${slug(d.name)}`, kind: "driver", source_ref: driverRef, value_num: null, value_text: d.framing ?? d.name, period: null });
  }

  // scenario.<band> — Monte-Carlo output bands (P50 point carried as the numeric value).
  const scenarioRef = firstRef(content.scenario?.provenance) ?? filingRef;
  for (const [band, b] of Object.entries(content.scenario?.bands ?? {})) {
    facts.push({
      fact_key: `scenario.${band}`,
      kind: "scenario",
      source_ref: scenarioRef,
      value_num: typeof b?.p50 === "number" && Number.isFinite(b.p50) ? b.p50 : null,
      value_text: null,
      period: content.scenario?.target_period ?? null,
    });
  }

  // levers.<k> — computed ROE / balance-sheet / working-capital metrics (numeric leaves only).
  for (const group of Object.values(content.levers ?? {})) {
    if (!group || typeof group !== "object") continue;
    for (const [k, v] of Object.entries(group as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      facts.push({ fact_key: `levers.${k}`, kind: "levers", source_ref: filingRef, value_num: v, value_text: null, period: model?.period_end ?? null });
    }
  }

  // external — advisory market context (consensus / analyst view), a single non-numeric node.
  if (content.market_context) {
    facts.push({ fact_key: "external", kind: "external", source_ref: firstRef(content.market_context.provenance), value_num: null, value_text: "market_context", period: null });
  }

  return facts;
}

/** Derive one claim per published narrative statement. PURE. */
export function extractClaims(content: DagContent): ClaimDescriptor[] {
  const claims: ClaimDescriptor[] = [];
  const push = (claim_kind: string, text: string | undefined | null, ordinal: number) => {
    const t = (typeof text === "string" ? text : "").trim(); // defensive: never .trim a non-string
    if (t) claims.push({ claim_kind, ordinal, text: t });
  };
  const th = content.thesis;
  push("one_liner", th?.one_liner, 0);
  push("long_form", th?.long_form, 0);
  (th?.tensions ?? []).forEach((t, i) => push("tension", t, i));
  (th?.invalidation_triggers ?? []).forEach((t, i) => push("invalidation_trigger", t, i));
  (content.key_debates ?? []).forEach((d, i) => push("key_debate", typeof d === "string" ? d : [d?.question, d?.lean].filter(Boolean).join(" — "), i));
  (content.scenario?.watch_items ?? []).forEach((t, i) => push("watch_item", t, i));
  (content.hypotheses?.drivers ?? []).forEach((d, i) => push("driver_framing", d.framing ?? d.name, i));
  return claims;
}

/** Keyword tokens (>= minKeywordLen) derived from a fact's metric name — the words a claim would use. */
function factKeywords(f: FactDescriptor, minLen: number): string[] {
  const metric = f.fact_key.includes(".") ? f.fact_key.slice(f.fact_key.indexOf(".") + 1) : f.fact_key;
  const toks = metric.split(/[._-]+/).map((t) => t.toLowerCase()).filter((t) => t.length >= minLen);
  return [...new Set(toks)];
}

/** Resolve claim->fact edges by keyword match. A claim that matches ZERO facts specifically links to
 *  ALL numeric facts (broadFallback) so a later correction still propagates. Returns fact_keys per
 *  claim index (aligned with the `claims` array). PURE. */
export function resolveEdges(claims: ClaimDescriptor[], facts: FactDescriptor[], config: ClaimDagConfig = CLAIM_DAG_CONFIG): string[][] {
  const kw = facts.map((f) => factKeywords(f, config.minKeywordLen));
  const numericKeys = facts.filter((f) => f.value_num != null).map((f) => f.fact_key);
  return claims.map((c) => {
    const text = c.text.toLowerCase();
    const matched: string[] = [];
    facts.forEach((f, i) => {
      if (kw[i].some((k) => text.includes(k))) matched.push(f.fact_key);
    });
    if (matched.length === 0 && config.broadFallback) return [...numericKeys];
    return matched;
  });
}

// ---------------------------------------------------------------------------
// Persistence (mutable claim_dag tables)
// ---------------------------------------------------------------------------
async function loadSnapshotContent(snapshotId: string): Promise<{ companyId: string; content: DagContent } | null> {
  const { rows } = await query<{ company_id: string; content: DagContent }>(
    "SELECT company_id, content FROM canonical_snapshots WHERE snapshot_id = $1",
    [snapshotId],
  );
  if (!rows[0]) return null;
  return { companyId: rows[0].company_id, content: rows[0].content ?? {} };
}

/** Read the snapshot content, derive facts/claims/edges, and (re)persist them idempotently: in ONE
 *  transaction, delete this snapshot's existing rows then insert facts -> claims -> edges. */
export async function buildClaimDag(snapshotId: string, config: ClaimDagConfig = CLAIM_DAG_CONFIG): Promise<ClaimDagCounts> {
  const loaded = await loadSnapshotContent(snapshotId);
  if (!loaded) return { facts: 0, claims: 0, edges: 0 };
  const { companyId, content } = loaded;

  const facts = catalogFacts(content);
  const claims = extractClaims(content);
  const edges = resolveEdges(claims, facts, config);

  return withTransaction(async (client) => {
    // Idempotent rebuild: drop this snapshot's rows first (claim_fact_edges cascade off claims/facts).
    await client.query("DELETE FROM claims WHERE snapshot_id = $1", [snapshotId]);
    await client.query("DELETE FROM claim_facts WHERE snapshot_id = $1", [snapshotId]);

    const factId = new Map<string, string>();
    for (const f of facts) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO claim_facts (snapshot_id, company_id, fact_key, kind, source_ref, value_num, value_text, period)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (snapshot_id, fact_key) DO UPDATE SET kind = EXCLUDED.kind
         RETURNING id`,
        [snapshotId, companyId, f.fact_key, f.kind, f.source_ref, f.value_num, f.value_text, f.period],
      );
      factId.set(f.fact_key, rows[0].id);
    }

    let edgeCount = 0;
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO claims (snapshot_id, company_id, claim_kind, ordinal, text)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [snapshotId, companyId, c.claim_kind, c.ordinal, c.text],
      );
      const claimId = rows[0].id;
      for (const fk of edges[i]) {
        const fid = factId.get(fk);
        if (!fid) continue;
        await client.query(
          "INSERT INTO claim_fact_edges (claim_id, fact_id, relation) VALUES ($1,$2,'consumes') ON CONFLICT DO NOTHING",
          [claimId, fid],
        );
        edgeCount++;
      }
    }

    return { facts: facts.length, claims: claims.length, edges: edgeCount };
  });
}

/** Flip a fact's status and stale every claim that consumes it (via edges). Returns claims staled. */
async function flipFact(status: "corrected" | "retracted", input: { snapshotId: string; factKey: string; reason: string; supersededBy?: string | null }): Promise<number> {
  const { snapshotId, factKey, reason, supersededBy } = input;
  return withTransaction(async (client) => {
    const upd = await client.query<{ id: string }>(
      `UPDATE claim_facts
          SET status = $3, correction_reason = $4, corrected_at = now(), superseded_by = $5
        WHERE snapshot_id = $1 AND fact_key = $2
        RETURNING id`,
      [snapshotId, factKey, status, reason, supersededBy ?? null],
    );
    const factRow = upd.rows[0];
    if (!factRow) return 0;
    // Every fresh claim linked to this fact goes stale (retracted claims are left as-is).
    const staled = await client.query(
      `UPDATE claims
          SET status = 'stale', stale_reason = $2, stale_at = now()
        WHERE status = 'fresh'
          AND id IN (SELECT claim_id FROM claim_fact_edges WHERE fact_id = $1)`,
      [factRow.id, `${status}: ${reason}`],
    );
    return staled.rowCount ?? 0;
  });
}

/** Mark a fact CORRECTED (a superseding value landed) and stale its dependent claims. */
export function markFactCorrected(input: { snapshotId: string; factKey: string; reason: string; supersededBy?: string | null }): Promise<number> {
  return flipFact("corrected", input);
}

/** Mark a fact RETRACTED (e.g. a hard accounting-identity failure) and stale its dependent claims. */
export function retractFact(input: { snapshotId: string; factKey: string; reason: string; supersededBy?: string | null }): Promise<number> {
  return flipFact("retracted", input);
}

/** Retract ONE claim (operator veto of a single statement). */
export async function retractClaim(claimId: string, reason: string): Promise<boolean> {
  const r = await query(
    "UPDATE claims SET status = 'retracted', stale_reason = $2, stale_at = now() WHERE id = $1",
    [claimId, reason],
  );
  return (r.rowCount ?? 0) > 0;
}

interface FactRow { snapshot_id: string; fact_key: string; value_num: number | null; period: string | null }

const relDiff = (prior: number, next: number): number => {
  const denom = Math.abs(prior);
  if (denom === 0) return next === 0 ? 0 : Infinity;
  return Math.abs(prior - next) / denom;
};

/** Compare a company's prior active facts to a NEW snapshot's facts and correct the prior facts that
 *  were restated: same fact_key + SAME period diverging beyond restatementRelThreshold, or a fact_key
 *  that vanished entirely. A routine next-period filing (a different period for the same key) does NOT
 *  flag. Returns the number of claims staled by the propagation. */
export async function propagateRestatement(companyId: string, newSnapshotId: string, config: ClaimDagConfig = CLAIM_DAG_CONFIG): Promise<number> {
  const [newRows, priorRows] = await Promise.all([
    query<FactRow>("SELECT snapshot_id, fact_key, value_num, period FROM claim_facts WHERE snapshot_id = $1", [newSnapshotId]),
    query<FactRow & { id: string }>(
      "SELECT id, snapshot_id, fact_key, value_num, period FROM claim_facts WHERE company_id = $1 AND snapshot_id <> $2 AND status = 'active'",
      [companyId, newSnapshotId],
    ),
  ]);

  const newKeys = new Set<string>();
  const newByKeyPeriod = new Map<string, number>();
  const newIdByKeyPeriod = new Map<string, string>();
  for (const f of newRows.rows) {
    newKeys.add(f.fact_key);
    if (f.value_num != null && f.period != null) newByKeyPeriod.set(`${f.fact_key}@${f.period}`, Number(f.value_num));
  }
  // Map new fact ids for supersession (needs a second small query keyed by id).
  const newIds = await query<{ id: string; fact_key: string; period: string | null }>(
    "SELECT id, fact_key, period FROM claim_facts WHERE snapshot_id = $1", [newSnapshotId],
  );
  for (const f of newIds.rows) if (f.period != null) newIdByKeyPeriod.set(`${f.fact_key}@${f.period}`, f.id);

  let staled = 0;
  for (const pf of priorRows.rows) {
    if (pf.value_num == null) continue; // only numeric facts can be restated/vanish-flagged
    const prior = Number(pf.value_num);
    let flag: { reason: string; supersededBy: string | null } | null = null;

    if (pf.period != null) {
      const key = `${pf.fact_key}@${pf.period}`;
      const nv = newByKeyPeriod.get(key);
      if (nv != null) {
        if (relDiff(prior, nv) > config.restatementRelThreshold) {
          flag = { reason: `restated ${pf.fact_key} (${pf.period}): ${prior} -> ${nv}`, supersededBy: newIdByKeyPeriod.get(key) ?? null };
        }
      } else if (!newKeys.has(pf.fact_key)) {
        flag = { reason: `fact ${pf.fact_key} vanished from ${newSnapshotId}`, supersededBy: null };
      }
    } else if (!newKeys.has(pf.fact_key)) {
      flag = { reason: `fact ${pf.fact_key} vanished from ${newSnapshotId}`, supersededBy: null };
    }

    if (flag) {
      staled += await markFactCorrected({ snapshotId: pf.snapshot_id, factKey: pf.fact_key, reason: flag.reason, supersededBy: flag.supersededBy });
    }
  }
  return staled;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------
export interface SnapshotClaimHealth {
  claims_fresh: number;
  claims_stale: number;
  claims_retracted: number;
  facts_active: number;
  facts_corrected: number;
  facts_retracted: number;
}

export async function hasStaleClaims(snapshotId: string): Promise<boolean> {
  const { rows } = await query<{ n: number }>(
    "SELECT count(*)::int n FROM claims WHERE snapshot_id = $1 AND status = 'stale'", [snapshotId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function snapshotClaimHealth(snapshotId: string): Promise<SnapshotClaimHealth> {
  const c = await query<{ status: string; n: number }>(
    "SELECT status, count(*)::int n FROM claims WHERE snapshot_id = $1 GROUP BY status", [snapshotId],
  );
  const f = await query<{ status: string; n: number }>(
    "SELECT status, count(*)::int n FROM claim_facts WHERE snapshot_id = $1 GROUP BY status", [snapshotId],
  );
  const cm = new Map(c.rows.map((r) => [r.status, r.n]));
  const fm = new Map(f.rows.map((r) => [r.status, r.n]));
  return {
    claims_fresh: cm.get("fresh") ?? 0,
    claims_stale: cm.get("stale") ?? 0,
    claims_retracted: cm.get("retracted") ?? 0,
    facts_active: fm.get("active") ?? 0,
    facts_corrected: fm.get("corrected") ?? 0,
    facts_retracted: fm.get("retracted") ?? 0,
  };
}
