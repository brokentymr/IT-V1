/**
 * Content substance assembly (Phase 8). Pulls the canonical file into the normalized "substance" object
 * every consumable is built from — and enforces the §8 gate: content is produced ONLY from an APPROVED
 * snapshot. Resolves the provenance source list so each consumable can cite its claims. The generators
 * turn this structured substance into plain-language formats; this layer stays precise.
 */
import { query } from "../db/pool";
import { snapshotClaimHealth } from "../engines/claim_dag";

export class NotApprovedError extends Error {
  constructor(ticker: string) { super(`${ticker}: latest research is not approved — content requires the §8 human checkpoint`); this.name = "NotApprovedError"; }
}

export interface ProvenanceItem { ref: string; origin: string; url: string | null; title: string | null }

export interface Substance {
  company: { id: string; legal_name: string; ticker: string | null; sector: string | null; listing: string; positions_held: unknown[] };
  snapshot_id: string;
  as_of: string;
  cycle_label: string;
  approved_at: string;
  thesis: {
    one_liner: string; long_form: string; tensions: string[]; invalidation_triggers: string[]; conviction: number | null;
    // Control P10: typed risks & triggers as one joined system (empty when a legacy snapshot only has string triggers).
    risks: Array<{ id: string; title: string; mechanism: string; quantified_impact: string | null; severity: string; linked_trigger_id: string | null }>;
    triggers: Array<{ id: string; condition: string; disclosure: string; source_ref: string | null }>;
  };
  numbers: Array<{ label: string; value: number; unit: string; yoy_pct: number | null; basis: string }>;
  // Control P11: GAAP vs non-GAAP reconciliation + the (adjusted) FCF bridge, when present.
  basis_reconciliation?: Array<{ metric: string; gaap_value: number; non_gaap_value: number; delta: number; gaap_label: string; non_gaap_label: string }>;
  fcf_bridge?: { ocf: number; capex: number; fcf: number } | null;
  scenario: { target_period: string | null; revenue?: { p10: number; p50: number; p90: number }; eps?: { p10: number; p50: number; p90: number }; beat_rev: number | null; watch_items: string[] } | null;
  drivers: Array<{ name: string; direction: string; framing: string }>;
  sentiment: { gap_direction: string; gap_magnitude: string; gap_rationale: string; ground_momentum: string; by_platform: Array<{ platform: string; sentiment: number; trend: string }> } | null;
  signals: Array<{ ts: string; kind: string; price: number | null }>;
  rolling_outlook: string;
  open_areas: Array<{ theme: string; title: string }>;
  // Control P12: the positioning readout + read-through relationships surfaced to the consumables.
  positioning?: {
    strategic_stance: string; variant_view: string; is_consensus: boolean;
    fair_value: { low: number | null; base: number | null; high: number | null; multiple: number | null; basis: string; consistent_with_lean: boolean; reconciliation: string } | null;
    implied_assumptions: string[];
    action_rules: Array<{ trigger: string; rule: string }>;
  } | null;
  external_relationships?: Array<{ counterparty_name: string; ticker: string | null; type: string | null; materiality: string | null; rationale: string | null; read_through: string | null; to_company_id: string | null }>;
  provenance: ProvenanceItem[];
  // Control P4: claim dependency DAG health for this snapshot (opt-in; zeros for pre-P4 snapshots).
  claim_health?: { claims_fresh: number; claims_stale: number; claims_retracted: number; facts_active: number; facts_corrected: number; facts_retracted: number };
}

interface SnapContent {
  thesis?: {
    one_liner?: string; long_form?: string; tensions?: string[]; invalidation_triggers?: string[]; conviction?: number;
    risks?: Array<{ id: string; title: string; mechanism: string; quantified_impact: string | null; severity: string; linked_trigger_id: string | null }>;
    triggers?: Array<{ id: string; condition: string; disclosure: string; source_ref: string | null }>;
  };
  fundamentals?: { model?: { line_items?: Record<string, { key?: string; label: string; value: number; unit: string; basis?: string; yoy?: { change_pct: number } | null }> }; provenance?: Array<{ source_ref: string }> };
  basis?: {
    line_item_basis?: Record<string, string>;
    fcf_bridge?: { ocf: number; capex: number; fcf: number } | null;
    reconciliations?: Array<{ metric: string; gaap_value: number; non_gaap_value: number; delta: number; gaap_label: string; non_gaap_label: string }>;
    provenance?: Array<{ source_ref: string }>;
  };
  scenario?: { target_period?: string | null; bands?: { revenue?: { p10: number; p50: number; p90: number }; eps?: { p10: number; p50: number; p90: number } }; beat_probability?: { revenue: number | null }; watch_items?: string[]; provenance?: Array<{ source_ref: string }> };
  hypotheses?: { drivers?: Array<{ name: string; direction: string; framing: string }> };
  research?: { provenance?: Array<{ source_ref: string }> };
  positioning?: {
    strategic_stance?: string; variant_view?: string; is_consensus?: boolean;
    fair_value?: { low: number | null; base: number | null; high: number | null; multiple: number | null; basis: string; consistent_with_lean: boolean; reconciliation: string } | null;
    implied_assumptions?: string[];
    action_rules?: Array<{ trigger: string; rule: string }>;
  };
}

/** Assemble the approved substance for a company. Throws NotApprovedError if the target snapshot
 *  has no active ('approved') approval row. When `snapshotId` is given the content is pinned to that
 *  exact snapshot (the auto-commit path pins the snapshot that cleared the bar, avoiding a race with a
 *  newer unapproved snapshot); omitted, it resolves the latest (the manual UI path). */
export async function assembleSubstance(companyId: string, snapshotId?: string): Promise<Substance> {
  const c = await query<{ id: string; legal_name: string; primary_ticker: string | null; gics_sector: string | null; listing: string; positions_held: unknown[]; current_events: { rolling_outlook?: string; brand_sentiment?: Record<string, unknown> } }>(
    `SELECT c.id, c.legal_name, c.primary_ticker, c.gics_sector, c.listing,
            COALESCE(c.coverage->'positions_held','[]') AS positions_held,
            COALESCE(cf.current_events,'{}') AS current_events
       FROM companies c LEFT JOIN canonical_files cf ON cf.company_id = c.id WHERE c.id = $1`,
    [companyId],
  );
  if (!c.rows[0]) throw new Error(`company ${companyId} not found`);
  const co = c.rows[0];

  const s = snapshotId
    ? await query<{ snapshot_id: string; as_of: string; cycle_label: string; content: SnapContent }>(
        `SELECT snapshot_id, to_char(as_of,'YYYY-MM-DD') AS as_of, cycle_label, content
           FROM canonical_snapshots WHERE company_id = $1 AND snapshot_id = $2`,
        [companyId, snapshotId],
      )
    : await query<{ snapshot_id: string; as_of: string; cycle_label: string; content: SnapContent }>(
        `SELECT snapshot_id, to_char(as_of,'YYYY-MM-DD') AS as_of, cycle_label, content
           FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 1`,
        [companyId],
      );
  const snap = s.rows[0];
  if (!snap) throw new NotApprovedError(co.primary_ticker ?? co.legal_name);

  const appr = await query<{ approved_at: string; edited_thesis: { one_liner?: string | null; long_form?: string | null } | null }>(
    "SELECT to_char(approved_at,'YYYY-MM-DD\"T\"HH24:MI:SS') AS approved_at, edited_thesis FROM thesis_approvals WHERE snapshot_id = $1 AND status = 'approved'",
    [snap.snapshot_id],
  );
  if (!appr.rows[0]) throw new NotApprovedError(co.primary_ticker ?? co.legal_name);

  const content = snap.content ?? {};
  const baseThesis = content.thesis ?? {};
  const edited = appr.rows[0].edited_thesis;
  const thesis = {
    one_liner: edited?.one_liner ?? baseThesis.one_liner ?? "",
    long_form: edited?.long_form ?? baseThesis.long_form ?? "",
    tensions: baseThesis.tensions ?? [],
    invalidation_triggers: baseThesis.invalidation_triggers ?? [],
    risks: baseThesis.risks ?? [], // control P10: typed risks (empty for legacy snapshots)
    triggers: baseThesis.triggers ?? [], // control P10: typed triggers with verifiable disclosure
    conviction: baseThesis.conviction ?? null,
  };

  const lineItemBasis = content.basis?.line_item_basis ?? {};
  const numbers = Object.entries(content.fundamentals?.model?.line_items ?? {}).slice(0, 6).map(([key, li]) => ({
    label: li.label, value: li.value, unit: li.unit, yoy_pct: li.yoy ? li.yoy.change_pct : null,
    basis: lineItemBasis[key] ?? li.basis ?? "gaap", // control P11: reporting basis of the figure
  }));

  const sc = content.scenario;
  const scenario = sc?.bands?.revenue ? {
    target_period: sc.target_period ?? null, revenue: sc.bands.revenue, eps: sc.bands.eps,
    beat_rev: sc.beat_probability?.revenue ?? null, watch_items: sc.watch_items ?? [],
  } : null;

  const bs = co.current_events?.brand_sentiment as undefined | { sentiment_vs_fundamentals_gap?: { direction: string; magnitude: string }; gap_rationale?: string; ground_momentum?: string; by_platform?: Array<{ platform: string; sentiment: number; trend: string }> };
  const sentiment = bs?.sentiment_vs_fundamentals_gap ? {
    gap_direction: bs.sentiment_vs_fundamentals_gap.direction, gap_magnitude: bs.sentiment_vs_fundamentals_gap.magnitude,
    gap_rationale: bs.gap_rationale ?? "", ground_momentum: bs.ground_momentum ?? "",
    by_platform: (bs.by_platform ?? []).map((p) => ({ platform: p.platform, sentiment: p.sentiment, trend: p.trend })),
  } : null;

  const sig = await query<{ ts: string; kind: string; payload: { price?: number } }>(
    "SELECT to_char(ts,'YYYY-MM-DD\"T\"HH24:MI:SS') AS ts, kind, payload FROM signal_events WHERE company_id = $1 ORDER BY ts DESC LIMIT 5", [companyId],
  );

  const areas = await query<{ theme: string; title: string }>(
    "SELECT theme, title FROM areas_of_interest WHERE company_id = $1 AND status <> 'resolved' ORDER BY score DESC LIMIT 8", [companyId],
  );

  // Control P12: read-through relationships (uncovered counterparties) + their source rows.
  const rels = await query<{ counterparty_name: string; ticker: string | null; type: string | null; materiality: string | null; rationale: string | null; read_through: string | null; to_company_id: string | null; source_ref: string | null }>(
    `SELECT counterparty_name, ticker, type, materiality, rationale, read_through,
            to_company_id::text AS to_company_id, source_ref::text AS source_ref
       FROM read_through_relationships WHERE company_id = $1
      ORDER BY CASE materiality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, counterparty_name`,
    [companyId],
  );
  const external_relationships = rels.rows.map((r) => ({
    counterparty_name: r.counterparty_name, ticker: r.ticker, type: r.type, materiality: r.materiality,
    rationale: r.rationale, read_through: r.read_through, to_company_id: r.to_company_id,
  }));

  const p = content.positioning;
  const positioning = p && (p.variant_view || p.strategic_stance) ? {
    strategic_stance: p.strategic_stance ?? "neutral", variant_view: p.variant_view ?? "", is_consensus: p.is_consensus ?? false,
    fair_value: p.fair_value ?? null, implied_assumptions: p.implied_assumptions ?? [], action_rules: p.action_rules ?? [],
  } : null;

  // Resolve the provenance source list (distinct source rows the snapshot cites).
  const refs = [...new Set([
    ...(content.fundamentals?.provenance ?? []).map((p) => p.source_ref),
    ...(content.scenario?.provenance ?? []).map((p) => p.source_ref),
    ...(content.basis?.provenance ?? []).map((p) => p.source_ref), // control P11
    ...(content.research?.provenance ?? []).map((p) => p.source_ref),
    ...rels.rows.map((r) => r.source_ref), // control P12: read-through source refs
  ].filter(Boolean))];
  const provenance: ProvenanceItem[] = refs.length
    ? (await query<{ ref: string; origin: string; url: string | null; title: string | null }>(
        "SELECT id AS ref, origin, url, title FROM sources WHERE id = ANY($1)", [refs],
      )).rows
    : [];

  // Control P4: attach the claim-DAG health for this snapshot (best-effort; zeros if the DAG is absent).
  const claim_health = await snapshotClaimHealth(snap.snapshot_id).catch(() => undefined);

  return {
    company: { id: co.id, legal_name: co.legal_name, ticker: co.primary_ticker, sector: co.gics_sector, listing: co.listing, positions_held: (co.positions_held as unknown[]) ?? [] },
    snapshot_id: snap.snapshot_id, as_of: snap.as_of, cycle_label: snap.cycle_label, approved_at: appr.rows[0].approved_at,
    thesis, numbers,
    basis_reconciliation: content.basis?.reconciliations ?? [],
    fcf_bridge: content.basis?.fcf_bridge ?? null,
    scenario, drivers: content.hypotheses?.drivers ?? [],
    sentiment, signals: sig.rows.map((r) => ({ ts: r.ts, kind: r.kind, price: r.payload?.price ?? null })),
    rolling_outlook: co.current_events?.rolling_outlook ?? "", open_areas: areas.rows,
    positioning, external_relationships, provenance,
    ...(claim_health ? { claim_health } : {}),
  };
}
