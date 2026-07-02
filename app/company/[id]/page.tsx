import { notFound } from "next/navigation";
import { getCompanyDetail } from "../../../lib/views/company";
import { loadCompanyChats } from "../../../lib/engines/company_chat";
import { runCoverage, runProfile, setAnalytics, setContent, approveThesis, vetoThesis, rollbackPublish, addLink, setLinkStatus, deleteLink } from "../../actions";
import { generateContentAction } from "../../content-actions";
import CompanyChat from "./CompanyChat";
import DeleteCompany from "../../DeleteCompany";
import { BASIS_CONFIG } from "../../../lib/config/fundamentals";
import { ENTITY_GATE } from "../../../lib/config/entity_gate";

export const dynamic = "force-dynamic";

const LINK_TYPES = ["competitor", "supplier", "customer", "parent", "subsidiary", "jv_partner", "shared_end_market", "thematic_peer", "macro_correlated"];

const fmtB = (n?: number | null) =>
  n == null ? "—" : Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toFixed(0)}`;
const pctf = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const dirTag = (d: string) => (d === "up" ? "good" : d === "down" ? "bad" : "");
const STANCE_LABEL: Record<string, string> = { strong_long: "Strong Long", constructive: "Constructive", neutral: "Neutral", cautious: "Cautious", avoid: "Avoid" };
const stanceTone = (s: string) => (s === "strong_long" || s === "constructive" ? "good" : s === "avoid" || s === "cautious" ? "bad" : "");
const dirWord = (d?: string) => (d === "positive" ? "▲" : d === "negative" ? "▼" : d === "mixed" ? "◆" : "•");
// Control P11: display the reporting basis of a figure (GAAP / non-GAAP / Adjusted / Unadjusted).
const basisLabel = (b?: string) => BASIS_CONFIG.displayLabels[(b ?? "gaap") as keyof typeof BASIS_CONFIG.displayLabels] ?? b ?? "GAAP";

interface Band { p10: number; p50: number; p90: number }
interface Profile { description?: string; founded?: string | null; headquarters?: string | null; total_funding?: string | null; last_valuation?: string | null; key_investors?: string[]; competitors?: string[]; recent?: string | null }
interface SnapContent {
  profile?: Profile;
  fundamentals?: { model?: { fiscal_period?: string; line_items?: Record<string, { label: string; value: number; unit: string; basis?: string; yoy?: { change_pct: number } | null }>; ratios?: Record<string, number> } };
  basis?: {
    line_item_basis?: Record<string, string>;
    fcf_bridge?: { ocf: number; capex: number; fcf: number } | null;
    reconciliations?: Array<{ metric: string; gaap_value: number; non_gaap_value: number; delta: number; gaap_label: string; non_gaap_label: string }>;
    unlabeled_flags?: string[];
  };
  scenario?: { target_period?: string | null; bands?: { revenue?: Band; net_income?: Band; eps?: Band }; beat_probability?: { revenue: number | null; eps: number | null }; sensitivity?: Array<{ driver: string; metric: string; contribution: number }>; watch_items?: string[] };
  market_context?: { consensus?: Record<string, unknown> | null; analyst_view?: Record<string, unknown> | null };
  thesis?: {
    one_liner?: string; long_form?: string; tensions?: string[]; invalidation_triggers?: string[]; conviction?: number;
    // Control P10: typed risks & triggers as one joined system.
    risks?: Array<{ id: string; title: string; mechanism: string; quantified_impact: string | null; severity: string; linked_trigger_id: string | null }>;
    triggers?: Array<{ id: string; condition: string; disclosure: string; source_ref: string | null }>;
  };
  hypotheses?: { drivers?: Array<{ name: string; metric: string; direction: string; framing: string; impact_pct: { bear: number; base: number; bull: number } }> };
  research?: {
    panel?: Array<{ lens: string; summary: string; key_points?: string[]; risks?: string[]; confidence: number }>;
    verification?: { confidence: number; missing_sources?: string[]; recommendation: string; verdicts?: Array<{ claim: string; status: string; note: string }> };
    grounding?: { coverage: number; supported: number; total: number };
    deepening?: { rounds?: Array<{ lever: string; confidence: number }>; cleared?: boolean; stopped_reason?: string; tiers_used?: string[]; llm_calls_total?: number } | null;
  };
  positioning?: {
    strategic_stance: string; tactical_stance?: string; conviction: number; conviction_basis?: string;
    variant_view: string; is_consensus?: boolean;
    price_target?: { bear: number | null; base: number | null; bull: number | null };
    expected_return_pct?: number | null; risk_reward?: string; horizon?: string; sizing_guidance?: string;
    catalysts?: Array<{ event: string; date: string | null; expected_direction?: string; why?: string }>;
    invalidation_triggers?: string[];
    // Control P12: positioning readout merged onto the decision.
    implied_assumptions?: string[];
    fair_value?: { low: number | null; base: number | null; high: number | null; multiple: number | null; basis: string; consistent_with_lean: boolean; reconciliation: string } | null;
    action_rules?: Array<{ trigger: string; rule: string }>;
  };
  key_debates?: Array<{ question: string; bull?: string; bear?: string; lean?: string }>;
  levers?: {
    roe?: { roe: number | null; net_margin: number | null; asset_turnover: number | null; equity_multiplier: number | null; driver?: string | null; read: string };
    balance_sheet?: { health: string; read: string; current_ratio: number | null; net_cash: number | null; interest_coverage: number | null; cash_conversion: number | null; free_cash_flow: number | null };
    working_capital?: { dso: number | null; dio: number | null; dpo: number | null; ccc: number | null };
  };
  demand?: {
    customers?: Array<{ name: string; share_pct?: number | null; relationship?: string; reliability?: string; note?: string }>;
    customer_concentration?: string;
    segments?: Array<{ name: string; revenue_share_pct?: number | null; trend?: string }>;
    geographic?: Array<{ region: string; revenue_share_pct?: number | null }>;
    demand_signals?: string;
    supply_constraints?: string;
  };
  // Control P5: per-filing-type disclosure coverage scorer.
  coverage_scorecard?: {
    form_type?: string; ok?: boolean; score?: number; covered?: string[];
    gaps?: Array<{ key: string; label: string; severity: string; detail: string; disclosed_but_missing?: boolean }>;
    percentage_flags?: Array<{ claim: string; detail: string }>;
  };
}
interface Diff { metrics?: Array<{ key: string; label: string; prior: number | null; current: number; change_pct: number | null; direction: string }> }

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ content_error?: string }> }) {
  const { id } = await params;
  const { content_error } = await searchParams;
  const d = await getCompanyDetail(id);
  if (!d) notFound();
  const { header: h, latest, approval, relationships, external_relationships, feed, signals, areas, sentiment, feed_filtered_count } = d;
  const content = (latest?.content ?? {}) as SnapContent;
  const diff = (latest?.diff ?? {}) as Diff;
  const sc = content.scenario;
  const thesis = approval?.edited_thesis ? { ...content.thesis, ...(approval.edited_thesis as object) } : content.thesis;
  const chats = await loadCompanyChats(id);

  return (
    <div className="wrap">
      {/* Header */}
      <div className="spread">
        <div>
          <h1 style={{ margin: 0 }}>{h.primary_ticker ?? h.legal_name} {h.primary_ticker ? <span className="faint" style={{ fontWeight: 400, fontSize: "1rem" }}>{h.legal_name}</span> : null}</h1>
          <div className="row" style={{ marginTop: ".4rem" }}>
            {h.listing !== "listed" ? <span className={`tag ${h.listing === "pre_ipo" ? "warn" : "accent"}`}>{h.listing.replace("_", "-")}</span> : null}
            <span className="tag">{h.gics_sector ?? "unclassified"}</span>
            <span className={`tag ${h.coverage_status === "monitoring" ? "good" : ""}`}>{h.coverage_status}</span>
            {h.content_enrolled ? <span className="tag accent">content-enrolled</span> : null}
            {h.next_earnings_date ? <span className="tag">next: {h.next_earnings_date}</span> : null}
            {latest ? <span className="tag">snapshot {latest.as_of} · {latest.cycle_label}</span> : <span className="tag warn">no coverage yet</span>}
          </div>
          {h.research_focus.length ? <div className="faint" style={{ marginTop: ".3rem", fontSize: ".82rem" }}>Research focus: {h.research_focus.join(" · ")}</div> : null}
        </div>
      </div>

      {/* Verdict box (Doc 2 §1) — the 10-second read: the call, the edge, the numbers, the catalysts. */}
      {content.positioning ? (() => {
        const p = content.positioning!;
        const pt = p.price_target;
        return (
          <div className="panel" style={{ marginTop: "1rem", borderLeft: "3px solid var(--accent, #6ea8fe)" }}>
            <div className="spread" style={{ alignItems: "baseline" }}>
              <div className="row" style={{ gap: ".5rem", alignItems: "baseline" }}>
                <span className={`tag ${stanceTone(p.strategic_stance)}`} style={{ fontSize: ".95rem" }}>{STANCE_LABEL[p.strategic_stance] ?? p.strategic_stance}</span>
                {p.tactical_stance ? <span className="tag">Tactical: {p.tactical_stance}</span> : null}
                <span className="mono faint">conviction {p.conviction}/5</span>
                {p.is_consensus ? <span className="tag warn">no edge · pass</span> : null}
              </div>
              {p.horizon ? <span className="faint" style={{ fontSize: ".8rem" }}>{p.horizon}</span> : null}
            </div>
            {(pt && (pt.bear != null || pt.base != null || pt.bull != null)) || p.risk_reward || p.sizing_guidance ? (
              <div className="row" style={{ gap: "1.2rem", marginTop: ".5rem", flexWrap: "wrap", fontSize: ".9rem" }}>
                {pt && (pt.bear != null || pt.base != null || pt.bull != null) ? (
                  <span className="mono"><span className="faint">Target </span>bear {pt.bear ?? "—"} · base {pt.base ?? "—"} · bull {pt.bull ?? "—"}</span>
                ) : null}
                {p.expected_return_pct != null ? <span className="mono"><span className="faint">Exp. return </span>{p.expected_return_pct}%</span> : null}
                {p.risk_reward ? <span className="mono"><span className="faint">R:R </span>{p.risk_reward}</span> : null}
                {p.sizing_guidance ? <span className="mono"><span className="faint">Size </span>{p.sizing_guidance}</span> : null}
              </div>
            ) : null}
            <p style={{ marginTop: ".6rem", marginBottom: 0, fontSize: ".95rem" }}>
              <span className="faint">Variant view: </span>{p.variant_view}
            </p>
            {/* Control P12: positioning readout — illustrative fair value + what spot is already pricing. */}
            {p.fair_value && (p.fair_value.base != null) ? (
              <div style={{ marginTop: ".5rem", fontSize: ".9rem" }}>
                <div className="row" style={{ gap: ".6rem", flexWrap: "wrap", alignItems: "baseline" }}>
                  <span className="mono"><span className="faint">Fair value </span>{p.fair_value.low ?? "—"} · <b>{p.fair_value.base}</b> · {p.fair_value.high ?? "—"}</span>
                  {p.fair_value.multiple != null ? <span className="mono faint">{p.fair_value.multiple}×</span> : null}
                  {p.fair_value.consistent_with_lean === false ? <span className="tag bad">lean vs spread conflict</span> : null}
                </div>
                {p.fair_value.reconciliation ? <div className="faint" style={{ fontSize: ".78rem", marginTop: ".2rem" }}>{p.fair_value.reconciliation}</div> : null}
                <p className="faint" style={{ fontSize: ".7rem", margin: ".2rem 0 0" }}>{p.fair_value.basis}</p>
              </div>
            ) : null}
            {p.implied_assumptions?.length ? (
              <div style={{ marginTop: ".4rem" }}>
                <span className="faint" style={{ fontSize: ".78rem" }}>What spot is pricing: </span>
                <ul className="list-tight muted" style={{ fontSize: ".82rem", marginTop: ".15rem" }}>{p.implied_assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            ) : null}
            {p.action_rules?.length ? (
              <details style={{ marginTop: ".4rem" }}>
                <summary className="faint" style={{ fontSize: ".78rem", cursor: "pointer" }}>Action rules ({p.action_rules.length})</summary>
                <ul className="list-tight muted" style={{ fontSize: ".82rem", marginTop: ".2rem" }}>
                  {p.action_rules.map((r, i) => <li key={i}><span className="faint">If </span>{r.trigger}<span className="faint"> → </span>{r.rule}</li>)}
                </ul>
              </details>
            ) : null}
            {p.catalysts?.length ? (
              <div style={{ marginTop: ".5rem" }}>
                <span className="faint" style={{ fontSize: ".78rem" }}>Catalysts: </span>
                {p.catalysts.map((c, i) => (
                  <span key={i} className="tag" style={{ marginRight: 4 }}>{dirWord(c.expected_direction)} {c.event}{c.date ? ` · ${c.date}` : ""}</span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {/* Key debates (Doc 2 §4) — the load-bearing questions, each owned with a lean. */}
      {content.key_debates?.length ? (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>Key debates</h2>
          {content.key_debates.map((d, i) => (
            <div key={i} style={{ padding: ".4rem 0", borderBottom: "1px solid var(--panel-2)" }}>
              <div style={{ fontWeight: 600, fontSize: ".9rem" }}>{d.question}</div>
              {d.bull ? <div className="muted" style={{ fontSize: ".82rem" }}><span className="faint">Bull: </span>{d.bull}</div> : null}
              {d.bear ? <div className="muted" style={{ fontSize: ".82rem" }}><span className="faint">Bear: </span>{d.bear}</div> : null}
              {d.lean ? <div style={{ fontSize: ".82rem" }}><span className="faint">Our lean: </span>{d.lean}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* Control surface */}
      <div className="panel" style={{ marginTop: "1rem" }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            {h.listing === "listed" ? (
              <form action={runCoverage} className="inline"><input type="hidden" name="company_id" value={h.id} /><button type="submit">▶ Run coverage (latest report)</button></form>
            ) : (
              <form action={runProfile} className="inline"><input type="hidden" name="company_id" value={h.id} /><button type="submit">▶ Build / refresh research profile</button></form>
            )}
            <form action={setAnalytics} className="inline">
              <input type="hidden" name="company_id" value={h.id} />
              <input type="hidden" name="on" value={h.coverage_status === "monitoring" ? "0" : "1"} />
              <button className="ghost" type="submit">{h.coverage_status === "monitoring" ? "✓ In analytics pipeline" : "+ Add to analytics pipeline"}</button>
            </form>
            <form action={setContent} className="inline">
              <input type="hidden" name="company_id" value={h.id} />
              <input type="hidden" name="on" value={h.content_enrolled ? "0" : "1"} />
              <button className="ghost" type="submit">{h.content_enrolled ? "✓ In content pipeline" : "+ Add to content pipeline"}</button>
            </form>
          </div>
          <div className="row" style={{ gap: ".8rem" }}>
            <DeleteCompany id={h.id} name={h.primary_ticker ?? h.legal_name} />
            <a href="/jobs" className="faint">watch pipeline →</a>
          </div>
        </div>
      </div>

      {/* Content generation — gated on the §8 human checkpoint (an approved thesis). */}
      {content_error ? <p className="tag warn" style={{ display: "block", marginTop: "1rem" }}>Content: {decodeURIComponent(content_error)}</p> : null}
      {approval ? (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <form action={generateContentAction} className="inline"><input type="hidden" name="company_id" value={h.id} /><button type="submit">✦ Generate content (deck · newsletter · short-form)</button></form>
              <a className="ghost" href={`/content/studio/${h.id}`} style={{ padding: ".4rem .8rem" }}>🎙 Podcast studio</a>
            </div>
            <a href="/content" className="faint">content library →</a>
          </div>
          <p className="faint" style={{ fontSize: ".78rem", marginTop: ".4rem" }}>Thesis approved {approval.approved_at.replace("T", " ")} — content builds from this approved snapshot, sourced and disclosed.</p>
        </div>
      ) : (
        <p className="faint" style={{ marginTop: "1rem", fontSize: ".82rem" }}>Approve the thesis (below) to unlock content generation — the §8 checkpoint gate.</p>
      )}

      {/* Areas of interest — between-filing developments accumulate from the headlines and the
          filing-triggered desk resolves them. The cluster of open items is the salience signal. */}
      {(areas.open.length || areas.resolved.length) ? (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <div className="spread">
            <h2>Areas of interest</h2>
            <span className={`tag ${areas.open.length ? "warn" : "good"}`}>{areas.open.length} open</span>
          </div>
          {areas.open.length === 0 ? <p className="faint" style={{ marginTop: 0 }}>No open areas — the desk is clear.</p> : null}
          {areas.open.map((a) => (
            <div key={a.id} style={{ padding: ".5rem 0", borderBottom: "1px solid var(--panel-2)" }}>
              <div className="row" style={{ gap: ".4rem" }}>
                <span className={`tag ${a.band === "major" ? "bad" : "warn"}`}>{a.band}</span>
                <span className="tag">{a.category}</span>
                {a.status === "carried_forward" ? <span className="tag accent">carried → revisit {a.revisit_after ?? "next quarter"}</span> : null}
                {a.mentions > 1 ? <span className="mono faint" style={{ fontSize: ".72rem" }}>×{a.mentions} headlines</span> : null}
                <span className="mono faint" style={{ fontSize: ".72rem" }}>score {a.score}</span>
              </div>
              <div style={{ fontSize: ".9rem", marginTop: ".15rem" }}>{a.title}</div>
              {a.headlines.length > 1 ? (
                <details style={{ marginTop: ".2rem" }}>
                  <summary className="faint" style={{ cursor: "pointer", fontSize: ".75rem" }}>{a.headlines.length} accumulated headlines</summary>
                  <ul className="list-tight faint" style={{ fontSize: ".78rem" }}>
                    {a.headlines.map((hl, i) => <li key={i}>{hl.url ? <a href={hl.url}>{hl.headline}</a> : hl.headline}</li>)}
                  </ul>
                </details>
              ) : null}
              {a.status === "carried_forward" && a.resolution_note ? <div className="faint" style={{ fontSize: ".78rem", marginTop: ".2rem" }}>{a.resolution_note}</div> : null}
            </div>
          ))}
          {areas.resolved.length ? (
            <details style={{ marginTop: ".6rem" }}>
              <summary className="muted" style={{ cursor: "pointer" }}>{areas.resolved.length} resolved</summary>
              <div style={{ marginTop: ".4rem" }}>
                {areas.resolved.map((a) => (
                  <div key={a.id} style={{ padding: ".4rem 0", borderBottom: "1px solid var(--panel-2)" }}>
                    <div className="row" style={{ gap: ".4rem" }}>
                      <span className={`tag ${a.disposition === "invalidated" ? "good" : a.disposition === "confirmed" ? "accent" : ""}`}>{a.disposition ?? "resolved"}</span>
                      <span className="tag">{a.category}</span>
                      {a.resolved_by_accession ? <span className="mono faint" style={{ fontSize: ".7rem" }}>via {a.resolved_by_accession}</span> : null}
                    </div>
                    <div className="muted" style={{ fontSize: ".85rem" }}>{a.title}</div>
                    {a.resolution_note ? <div className="faint" style={{ fontSize: ".78rem" }}>{a.resolution_note}</div> : null}
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="grid cols-2" style={{ marginTop: "1rem" }}>
        <div>
          {/* Thesis + human checkpoint */}
          <div className="panel">
            <div className="spread"><h2>Thesis</h2>{latest ? <span className="tag mono">conviction {thesis?.conviction ?? "—"}/5</span> : null}</div>
            {thesis?.one_liner ? <p style={{ fontSize: "1.1rem", marginTop: 0 }}>{thesis.one_liner}</p> : <p className="faint">Run coverage to generate a thesis.</p>}
            {thesis?.long_form ? <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{thesis.long_form}</p> : null}
            {thesis?.tensions?.length ? <><h3>Tensions</h3><ul className="list-tight muted">{thesis.tensions.map((t, i) => <li key={i}>{t}</li>)}</ul></> : null}
            {thesis?.invalidation_triggers?.length ? <><h3>Invalidation triggers</h3><ul className="list-tight muted">{thesis.invalidation_triggers.map((t, i) => <li key={i}>{t}</li>)}</ul></> : null}
            {/* Control P10: typed risks joined to their triggers (mechanism + severity + confirming disclosure). */}
            {thesis?.risks?.length ? (
              <><h3>Risks</h3><ul className="list-tight muted">{thesis.risks.map((r) => {
                const trig = r.linked_trigger_id ? thesis.triggers?.find((t) => t.id === r.linked_trigger_id) : undefined;
                return (
                  <li key={r.id}>
                    <span className={`tag ${r.severity === "high" ? "bad" : r.severity === "medium" ? "accent" : ""}`}>{r.severity}</span> {r.title}
                    {r.mechanism ? <span className="faint"> — {r.mechanism}</span> : null}
                    {r.quantified_impact ? <span className="mono faint"> ({r.quantified_impact})</span> : null}
                    {trig ? <div className="faint" style={{ fontSize: ".78rem" }}>Trigger: {trig.condition}{trig.disclosure ? ` — ${trig.disclosure}` : ""}</div> : null}
                  </li>
                );
              })}</ul></>
            ) : null}
            {latest ? (
              <div style={{ marginTop: ".8rem", borderTop: "1px solid var(--border)", paddingTop: ".8rem" }}>
                {approval ? (
                  <div className="grid" style={{ gap: ".4rem" }}>
                    <div className="row">
                      <span className={`tag ${approval.status === "vetoed" ? "bad" : "good"}`}>{approval.status === "vetoed" ? "✕ vetoed" : "✓ approved"}</span>
                      <span className="faint">{approval.approved_at.replace("T", " ")} · {approval.approved_by}</span>
                    </div>
                    {approval.status !== "vetoed" ? (
                      <div className="row" style={{ gap: ".4rem" }}>
                        <form action={vetoThesis} className="inline"><input type="hidden" name="company_id" value={h.id} /><input type="hidden" name="snapshot_id" value={latest.snapshot_id} /><button className="ghost" type="submit" style={{ fontSize: ".8rem" }}>Veto &amp; retract</button></form>
                        <form action={rollbackPublish} className="inline"><input type="hidden" name="company_id" value={h.id} /><input type="hidden" name="snapshot_id" value={latest.snapshot_id} /><button className="ghost" type="submit" style={{ fontSize: ".8rem" }}>Pull content</button></form>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <details>
                    <summary style={{ cursor: "pointer" }} className="muted">Approve thesis (admin override — the desk auto-publishes on its own)</summary>
                    <form action={approveThesis} style={{ marginTop: ".6rem" }} className="grid">
                      <input type="hidden" name="company_id" value={h.id} /><input type="hidden" name="snapshot_id" value={latest.snapshot_id} />
                      <input name="one_liner" placeholder="(optional) edit one-liner" defaultValue="" />
                      <textarea name="note" placeholder="(optional) approval note" rows={2} />
                      <div><button type="submit">Approve &amp; publish</button></div>
                    </form>
                  </details>
                )}
              </div>
            ) : null}
          </div>

          <CompanyChat companyId={h.id} turns={chats} suggestedFocus={content.research?.verification?.missing_sources ?? []} />

          {/* Analyst desk — expert panel + adversarial verification + confidence */}
          {content.research ? (
            <div className="panel">
              <div className="spread">
                <h2>Analyst desk</h2>
                {content.research.verification ? (
                  <span className={`tag ${content.research.verification.recommendation === "review" ? "warn" : "good"}`}>
                    confidence {(content.research.verification.confidence * 100).toFixed(0)}% · {content.research.verification.recommendation}
                  </span>
                ) : null}
              </div>
              {content.research.verification?.recommendation === "review" ? (
                <p className="tag warn" style={{ display: "block", marginBottom: ".5rem" }}>⚠ Below the confidence bar — held for review rather than auto-published.</p>
              ) : null}
              {content.research.deepening && (content.research.deepening.rounds?.length ?? 0) > 1 ? (
                <p className="faint" style={{ fontSize: ".72rem", marginBottom: ".5rem" }}>
                  Deepened {(content.research.deepening.rounds?.length ?? 1) - 1} round(s) · {content.research.deepening.stopped_reason} · tiers {(content.research.deepening.tiers_used ?? []).join(", ")}
                </p>
              ) : null}
              {content.research.panel?.map((p) => (
                <div key={p.lens} style={{ padding: ".4rem 0", borderBottom: "1px solid var(--panel-2)" }}>
                  <div className="row" style={{ gap: ".4rem" }}><span className="tag accent">{p.lens}</span><span className="mono faint" style={{ fontSize: ".72rem" }}>conf {(p.confidence * 100).toFixed(0)}%</span></div>
                  <div style={{ fontSize: ".88rem" }}>{p.summary}</div>
                  {p.risks?.length ? <div className="faint" style={{ fontSize: ".78rem" }}>risks: {p.risks.join("; ")}</div> : null}
                </div>
              ))}
              {content.research.verification?.missing_sources?.length ? (
                <p className="faint" style={{ fontSize: ".78rem", marginTop: ".5rem" }}>Missing to raise confidence: {content.research.verification.missing_sources.join("; ")}</p>
              ) : null}
            </div>
          ) : null}

          {/* Return levers & balance-sheet health (computed from XBRL — citable to the filing). */}
          {content.levers ? (() => {
            const L = content.levers!;
            const r = L.roe; const b = L.balance_sheet;
            const px = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
            const xx = (n?: number | null) => (n == null ? "—" : `${n.toFixed(2)}x`);
            const bn = (n?: number | null) => (n == null ? "—" : Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
            return (
              <div className="panel">
                <h2 style={{ marginTop: 0 }}>Return levers &amp; balance sheet</h2>
                {r ? (
                  <div style={{ marginBottom: ".5rem" }}>
                    <div className="row" style={{ gap: ".6rem", flexWrap: "wrap", fontSize: ".9rem" }}>
                      <span className="mono"><span className="faint">ROE </span>{px(r.roe)}</span>
                      <span className="faint">=</span>
                      <span className="mono">margin {px(r.net_margin)}</span><span className="faint">×</span>
                      <span className="mono">turnover {xx(r.asset_turnover)}</span><span className="faint">×</span>
                      <span className="mono">leverage {xx(r.equity_multiplier)}</span>
                      {r.driver ? <span className="tag accent">{r.driver}-driven</span> : null}
                    </div>
                    <p className="muted" style={{ fontSize: ".84rem", marginTop: ".3rem" }}>{r.read}</p>
                  </div>
                ) : null}
                {b ? (
                  <div style={{ borderTop: "1px solid var(--panel-2)", paddingTop: ".5rem" }}>
                    <div className="row" style={{ gap: ".6rem", flexWrap: "wrap", fontSize: ".9rem" }}>
                      <span className={`tag ${b.health === "strong" ? "good" : b.health === "stretched" ? "bad" : ""}`}>{b.health}</span>
                      {b.current_ratio != null ? <span className="mono"><span className="faint">current </span>{xx(b.current_ratio)}</span> : null}
                      {b.net_cash != null ? <span className="mono">{b.net_cash >= 0 ? "net cash " : "net debt "}{bn(Math.abs(b.net_cash))}</span> : null}
                      {b.interest_coverage != null ? <span className="mono"><span className="faint">int. cov </span>{xx(b.interest_coverage)}</span> : null}
                      {b.cash_conversion != null ? <span className="mono"><span className="faint">cash conv </span>{xx(b.cash_conversion)}</span> : null}
                      {b.free_cash_flow != null ? <span className="mono"><span className="faint">FCF </span>{bn(b.free_cash_flow)} <span className="tag faint" style={{ fontSize: ".68rem" }}>Adjusted</span></span> : null}
                    </div>
                    {content.basis?.fcf_bridge ? (
                      <p className="faint" style={{ fontSize: ".72rem", marginTop: ".3rem" }}>
                        FCF bridge (adjusted — company definition): OCF {bn(content.basis.fcf_bridge.ocf)} − capex {bn(content.basis.fcf_bridge.capex)} = {bn(content.basis.fcf_bridge.fcf)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {L.working_capital && L.working_capital.ccc != null ? (
                  <div className="row" style={{ gap: ".6rem", flexWrap: "wrap", fontSize: ".9rem", borderTop: "1px solid var(--panel-2)", paddingTop: ".5rem", marginTop: ".5rem" }}>
                    <span className="mono"><span className="faint">CCC </span>{L.working_capital.ccc.toFixed(0)}d</span>
                    <span className="mono faint">DSO {L.working_capital.dso?.toFixed(0) ?? "—"}d · DIO {L.working_capital.dio?.toFixed(0) ?? "—"}d · DPO {L.working_capital.dpo?.toFixed(0) ?? "—"}d</span>
                  </div>
                ) : null}
                <p className="faint" style={{ fontSize: ".72rem", marginTop: ".4rem" }}>Computed from XBRL — citable to the filing.</p>
              </div>
            );
          })() : null}

          {/* Reported basis / reconciliation (control P11 — GAAP vs non-GAAP, and unlabeled-figure flags). */}
          {content.basis && (content.basis.reconciliations?.length || content.basis.unlabeled_flags?.length) ? (() => {
            const bx = content.basis!;
            const fmtV = (metric: string, v: number) => (metric.includes("margin") ? pctf(v) : metric.includes("eps") ? v.toFixed(2) : fmtB(v));
            return (
              <div className="panel">
                <h2 style={{ marginTop: 0 }}>Reported basis &amp; reconciliation</h2>
                {bx.reconciliations?.length ? (
                  <table>
                    <thead><tr><th>Metric</th><th>GAAP</th><th>Non-GAAP</th><th>Δ</th></tr></thead>
                    <tbody>
                      {bx.reconciliations.map((r, i) => (
                        <tr key={i}>
                          <td>{r.metric.replace(/_/g, " ")}</td>
                          <td className="mono"><span className="faint">{r.gaap_label} </span>{fmtV(r.metric, r.gaap_value)}</td>
                          <td className="mono"><span className="faint">{r.non_gaap_label} </span>{fmtV(r.metric, r.non_gaap_value)}</td>
                          <td className="mono">{r.delta >= 0 ? "+" : ""}{fmtV(r.metric, r.delta)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {bx.unlabeled_flags?.length ? (
                  <div style={{ marginTop: ".5rem" }}>
                    <span className="tag bad">unlabeled basis</span>
                    <ul className="list-tight muted" style={{ fontSize: ".82rem", marginTop: ".3rem" }}>{bx.unlabeled_flags.map((f, i) => <li key={i}>{f}</li>)}</ul>
                  </div>
                ) : null}
                <p className="faint" style={{ fontSize: ".72rem" }}>Basis labeling — GAAP figures never conflated with non-GAAP/adjusted.</p>
              </div>
            );
          })() : null}

          {/* Disclosure coverage (control P5 — which expected disclosures are covered vs gapped). */}
          {content.coverage_scorecard && (content.coverage_scorecard.gaps?.length || content.coverage_scorecard.percentage_flags?.length || content.coverage_scorecard.covered?.length) ? (() => {
            const cs = content.coverage_scorecard!;
            return (
              <div className="panel">
                <div className="spread">
                  <h2 style={{ marginTop: 0 }}>Disclosure coverage</h2>
                  <span className={`tag ${cs.ok === false ? "bad" : "good"}`}>
                    {cs.ok === false ? "gap hold" : "covered"}{cs.score != null ? ` · ${(cs.score * 100).toFixed(0)}%` : ""}
                  </span>
                </div>
                {cs.covered?.length ? (
                  <p className="muted" style={{ fontSize: ".82rem" }}><span className="faint">Covered: </span>{cs.covered.join(", ")}</p>
                ) : null}
                {cs.gaps?.length ? (
                  <ul className="list-tight muted" style={{ fontSize: ".82rem", marginTop: ".3rem" }}>
                    {cs.gaps.map((g, i) => (
                      <li key={i}>
                        <span className={`tag ${g.severity === "critical" ? "bad" : "warn"}`}>{g.severity}</span>{" "}
                        {g.detail}{g.disclosed_but_missing ? " (disclosed but not captured)" : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {cs.percentage_flags?.length ? (
                  <div style={{ marginTop: ".4rem" }}>
                    <span className="tag warn">%-claim flags</span>
                    <ul className="list-tight muted" style={{ fontSize: ".8rem", marginTop: ".3rem" }}>{cs.percentage_flags.map((f, i) => <li key={i}>{f.claim} — {f.detail}</li>)}</ul>
                  </div>
                ) : null}
              </div>
            );
          })() : null}

          {/* Demand & customers (extracted from the primary filing text — citable). */}
          {content.demand && (content.demand.customers?.length || content.demand.customer_concentration || content.demand.segments?.length || content.demand.demand_signals) ? (() => {
            const d = content.demand!;
            const relTone = (r?: string) => (r === "reliable" ? "good" : r === "at_risk" ? "bad" : r === "cyclical" ? "warn" : "");
            return (
              <div className="panel">
                <h2 style={{ marginTop: 0 }}>Demand &amp; customers</h2>
                {d.customer_concentration ? <p className="muted" style={{ marginTop: 0, fontSize: ".88rem" }}><span className="faint">Concentration: </span>{d.customer_concentration}</p> : null}
                {d.customers?.length ? (
                  <table>
                    <thead><tr><th>Customer</th><th>Share</th><th>Reliability</th><th>Relationship</th></tr></thead>
                    <tbody>
                      {d.customers.map((c, i) => (
                        <tr key={i}>
                          <td>{c.name}</td>
                          <td className="mono">{c.share_pct != null ? `${c.share_pct}%` : "—"}</td>
                          <td>{c.reliability && c.reliability !== "unknown" ? <span className={`tag ${relTone(c.reliability)}`}>{c.reliability}</span> : <span className="faint">—</span>}</td>
                          <td className="muted" style={{ fontSize: ".82rem" }}>{c.relationship || c.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
                {d.segments?.length ? <p className="muted" style={{ fontSize: ".84rem" }}><span className="faint">Segments: </span>{d.segments.map((s) => `${s.name}${s.revenue_share_pct != null ? ` ${s.revenue_share_pct}%` : ""}${s.trend ? ` (${s.trend})` : ""}`).join(" · ")}</p> : null}
                {d.geographic?.length ? <p className="muted" style={{ fontSize: ".84rem" }}><span className="faint">Geography: </span>{d.geographic.map((g) => `${g.region}${g.revenue_share_pct != null ? ` ${g.revenue_share_pct}%` : ""}`).join(" · ")}</p> : null}
                {d.demand_signals ? <p className="muted" style={{ fontSize: ".84rem" }}><span className="faint">Demand signals: </span>{d.demand_signals}</p> : null}
                {d.supply_constraints ? <p className="muted" style={{ fontSize: ".84rem" }}><span className="faint">Supply: </span>{d.supply_constraints}</p> : null}
                <p className="faint" style={{ fontSize: ".72rem" }}>Extracted from the filing text — citable to the source.</p>
              </div>
            );
          })() : null}

          {/* Profile (private / pre-IPO names) */}
          {content.profile ? (
            <div className="panel">
              <h2>Profile</h2>
              {content.profile.description ? <p style={{ marginTop: 0 }} className="muted">{content.profile.description}</p> : null}
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: ".4rem .8rem", fontSize: ".88rem" }}>
                {[["Founded", content.profile.founded], ["HQ", content.profile.headquarters], ["Total funding", content.profile.total_funding], ["Last valuation", content.profile.last_valuation]].map(([k, v]) =>
                  v ? <div key={k as string}><span className="faint">{k as string}: </span>{v as string}</div> : null)}
              </div>
              {content.profile.key_investors?.length ? <p className="muted" style={{ fontSize: ".85rem" }}><span className="faint">Investors: </span>{content.profile.key_investors.join(", ")}</p> : null}
              {content.profile.competitors?.length ? <p className="muted" style={{ fontSize: ".85rem" }}><span className="faint">Competitors: </span>{content.profile.competitors.join(", ")}</p> : null}
              {content.profile.recent ? <><h3>Recent</h3><p className="muted" style={{ marginTop: 0, fontSize: ".85rem" }}>{content.profile.recent}</p></> : null}
              <p className="faint" style={{ fontSize: ".72rem" }}>Sourced via Perplexity — no SEC filings for a {h.listing.replace("_", "-")} company.</p>
            </div>
          ) : null}

          {/* Fundamentals + diff */}
          {content.fundamentals?.model?.line_items ? (
            <div className="panel">
              <div className="spread"><h2>Fundamentals</h2><span className="faint">{content.fundamentals.model.fiscal_period}</span></div>
              <table>
                <thead><tr><th>Line item</th><th>Value</th><th>Basis</th><th>YoY</th><th>Δ vs prior snapshot</th></tr></thead>
                <tbody>
                  {Object.entries(content.fundamentals.model.line_items).map(([key, li]) => {
                    const dm = diff.metrics?.find((m) => m.label === li.label);
                    const bl = basisLabel(content.basis?.line_item_basis?.[key] ?? li.basis);
                    return (
                      <tr key={li.label}>
                        <td>{li.label}</td>
                        <td className="mono">{li.unit === "USD/shares" ? li.value.toFixed(2) : fmtB(li.value)}</td>
                        <td><span className="tag faint" style={{ fontSize: ".72rem" }}>{bl}</span></td>
                        <td className="mono muted">{li.yoy ? pctf(li.yoy.change_pct) : "—"}</td>
                        <td>{dm && dm.change_pct != null ? <span className={`tag ${dirTag(dm.direction)}`}>{dm.direction} {pctf(dm.change_pct)}</span> : <span className="faint">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {content.fundamentals.model.ratios ? <p className="muted" style={{ fontSize: ".88rem" }}>Margins <span className="faint">(GAAP)</span>: {Object.entries(content.fundamentals.model.ratios).map(([k, v]) => `${k.replace("_", " ")} ${pctf(v)}`).join(" · ")}</p> : null}
            </div>
          ) : null}

          {/* Monte Carlo scenario */}
          {sc?.bands?.revenue ? (
            <div className="panel">
              <div className="spread"><h2>Next-period scenario (Monte Carlo)</h2><span className="faint">target {sc.target_period ?? "next period"}</span></div>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", marginBottom: ".6rem" }}>
                {[["Revenue", sc.bands.revenue, fmtB], ["Net income", sc.bands.net_income, fmtB], ["EPS", sc.bands.eps, (n?: number | null) => (n == null ? "—" : n.toFixed(2))]].map(([label, b, fmt]) => {
                  const band = b as Band | undefined; const f = fmt as (n?: number | null) => string;
                  return band ? (
                    <div key={label as string}>
                      <h3>{label as string}</h3>
                      <div className="bands"><span className="p50 mono">{f(band.p50)}</span></div>
                      <div className="faint mono" style={{ fontSize: ".8rem" }}>{f(band.p10)} – {f(band.p90)}</div>
                    </div>
                  ) : null;
                })}
              </div>
              <div className="row">
                {sc.beat_probability?.revenue != null ? <span className="tag accent">P(beat rev consensus) {pctf(sc.beat_probability.revenue)}</span> : null}
                {sc.beat_probability?.eps != null ? <span className="tag accent">P(beat EPS) {pctf(sc.beat_probability.eps)}</span> : null}
              </div>
              {sc.watch_items?.length ? <><h3 style={{ marginTop: ".8rem" }}>What to watch next</h3><ul className="list-tight muted">{sc.watch_items.map((w, i) => <li key={i}>{w}</li>)}</ul></> : null}
            </div>
          ) : null}

          {/* Relationships + read-throughs */}
          <div className="panel">
            <h2>Relationships</h2>
            <table>
              <thead><tr><th>Linked asset</th><th>Type</th><th>Status</th><th>Read-throughs</th><th /></tr></thead>
              <tbody>
                {relationships.map((r) => (
                  <tr key={r.id}>
                    <td><a href={`/company/${r.to_company_id}`}>{r.to_ticker ?? r.to_name}</a> {r.cross_sector ? <span className="tag" style={{ marginLeft: 4 }}>cross-sector</span> : null}</td>
                    <td className="muted">{r.type}</td>
                    <td><span className={`tag ${r.status === "active" ? "good" : r.status === "unverified" ? "warn" : ""}`}>{r.status}</span></td>
                    <td className="mono">{r.readthrough_count}</td>
                    <td className="row" style={{ gap: ".3rem" }}>
                      {r.status !== "active" ? <form action={setLinkStatus} className="inline"><input type="hidden" name="company_id" value={h.id} /><input type="hidden" name="link_id" value={r.id} /><input type="hidden" name="status" value="active" /><button className="ghost" style={{ padding: ".2rem .5rem", fontSize: ".8rem" }}>verify</button></form> : null}
                      <form action={deleteLink} className="inline"><input type="hidden" name="company_id" value={h.id} /><input type="hidden" name="link_id" value={r.id} /><button className="ghost" style={{ padding: ".2rem .5rem", fontSize: ".8rem" }}>✕</button></form>
                    </td>
                  </tr>
                ))}
                {relationships.length === 0 && <tr><td colSpan={5} className="faint">No links yet.</td></tr>}
              </tbody>
            </table>
            <form action={addLink} className="row" style={{ marginTop: ".7rem" }}>
              <input type="hidden" name="company_id" value={h.id} />
              <input name="to_ticker" placeholder="Link to ticker" style={{ width: 130 }} />
              <select name="type">{LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              <button className="ghost" type="submit">+ Add link</button>
            </form>

            {/* Control P12: read-through counterparties — named in the filing but not (yet) in our universe. */}
            {external_relationships.length ? (
              <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: ".7rem" }}>
                <h3 style={{ marginTop: 0 }}>Read-through counterparties <span className="faint" style={{ fontWeight: 400, fontSize: ".8rem" }}>(not yet covered)</span></h3>
                <table>
                  <thead><tr><th>Counterparty</th><th>Type</th><th>Materiality</th><th>Read-through</th></tr></thead>
                  <tbody>
                    {external_relationships.map((r) => (
                      <tr key={r.id}>
                        <td>{r.to_company_id ? <a href={`/company/${r.to_company_id}`}>{r.to_ticker ?? r.to_name ?? r.counterparty_name}</a> : (r.counterparty_name + (r.ticker ? ` (${r.ticker})` : ""))}</td>
                        <td className="muted">{r.type ?? "—"}</td>
                        <td>{r.materiality ? <span className={`tag ${r.materiality === "high" ? "bad" : r.materiality === "medium" ? "warn" : ""}`}>{r.materiality}</span> : <span className="faint">—</span>}</td>
                        <td className="muted" style={{ fontSize: ".82rem" }}>{r.read_through || r.rationale || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="faint" style={{ fontSize: ".72rem" }}>Surfaced from the filing text — customers, suppliers and partners we don&apos;t cover directly.</p>
              </div>
            ) : null}
          </div>
        </div>

        {/* Sidebar: sentiment, market context, signals, feed, history */}
        <div>
          {sentiment ? (
            <div className="panel">
              <div className="spread">
                <h2>Sentiment</h2>
                <span className={`tag ${sentiment.confidence != null && sentiment.confidence < 0.5 ? "warn" : ""}`}>conf {sentiment.confidence != null ? `${(sentiment.confidence * 100).toFixed(0)}%` : "—"}</span>
              </div>
              {/* The gap — the headline read */}
              <div className="row" style={{ gap: ".4rem", marginBottom: ".4rem" }}>
                <span className={`tag ${sentiment.sentiment_vs_fundamentals_gap.direction === "sentiment_ahead" ? "warn" : sentiment.sentiment_vs_fundamentals_gap.direction === "sentiment_behind" ? "accent" : "good"}`}>
                  {sentiment.sentiment_vs_fundamentals_gap.direction === "sentiment_ahead" ? "crowd ahead of fundamentals" : sentiment.sentiment_vs_fundamentals_gap.direction === "sentiment_behind" ? "crowd behind fundamentals" : "aligned"}
                </span>
                <span className="tag">{sentiment.sentiment_vs_fundamentals_gap.magnitude} gap</span>
              </div>
              {sentiment.gap_rationale ? <p className="muted" style={{ marginTop: 0, fontSize: ".85rem" }}>{sentiment.gap_rationale}</p> : null}
              {sentiment.ground_momentum ? <p className="muted" style={{ fontSize: ".85rem" }}>{sentiment.ground_momentum}</p> : null}
              <table>
                <thead><tr><th>Platform</th><th>Vol</th><th>Net</th><th>Trend</th></tr></thead>
                <tbody>
                  {sentiment.by_platform.map((p) => (
                    <tr key={p.platform}>
                      <td>{p.platform}{p.top_themes?.length ? <div className="faint" style={{ fontSize: ".72rem" }}>{p.top_themes.join(" · ")}</div> : null}</td>
                      <td className="mono">{p.volume}</td>
                      <td>{p.low_volume ? <span className="faint" style={{ fontSize: ".72rem" }}>{p.net_display}</span> : <span className={`tag ${p.sentiment > 0.15 ? "good" : p.sentiment < -0.15 ? "bad" : ""}`}>{p.net_display ?? `${p.sentiment > 0 ? "+" : ""}${p.sentiment.toFixed(2)}`}</span>}</td>
                      <td className="muted">{p.trend}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {sentiment.degraded?.length ? <p className="faint" style={{ fontSize: ".72rem" }}>Degraded: {sentiment.degraded.length} source(s) — confidence lowered.</p> : null}
            </div>
          ) : null}

          {content.market_context ? (
            <div className="panel">
              <h2>Market context</h2>
              {(content.market_context.consensus as { summary?: string } | null)?.summary ? <><h3>Consensus</h3><p className="muted" style={{ marginTop: 0, fontSize: ".88rem" }}>{(content.market_context.consensus as { summary?: string }).summary}</p></> : null}
              {(content.market_context.analyst_view as { summary?: string } | null)?.summary ? <><h3>Analyst view</h3><p className="muted" style={{ marginTop: 0, fontSize: ".88rem" }}>{(content.market_context.analyst_view as { summary?: string }).summary}</p></> : null}
              <p className="faint" style={{ fontSize: ".75rem" }}>Advisory (Perplexity / Fiscal.ai) — not the modeled numbers.</p>
            </div>
          ) : null}

          <div className="panel">
            <h2>Current events</h2>
            <div style={{ maxHeight: 360, overflow: "auto" }}>
              {feed.map((n) => (
                <div key={n.id} style={{ padding: ".4rem 0", borderBottom: "1px solid var(--panel-2)" }}>
                  <div className="row" style={{ gap: ".4rem" }}>
                    <span className={`tag ${n.origin_kind === "read_through" ? "accent" : ""}`}>{n.origin_kind === "read_through" ? "read-through" : n.category}</span>
                    <span className="mono faint" style={{ fontSize: ".75rem" }}>{n.importance_score}</span>
                  </div>
                  <div style={{ fontSize: ".88rem" }}>{n.headline}</div>
                  <div className="faint" style={{ fontSize: ".72rem" }}>{n.detected_at.replace("T", " ")}</div>
                </div>
              ))}
              {feed.length === 0 && <p className="faint">No notes yet.</p>}
            </div>
            {feed_filtered_count > 0 ? (
              <details style={{ marginTop: ".5rem" }}>
                <summary className="faint" style={{ fontSize: ".72rem", cursor: "pointer" }}>
                  {feed_filtered_count} low-importance item{feed_filtered_count === 1 ? "" : "s"} filtered
                </summary>
                <div className="faint" style={{ fontSize: ".72rem", marginTop: ".3rem" }}>
                  Uncategorized notes below importance {ENTITY_GATE.otherCategoryImportanceFloor} are hidden to keep the feed signal-dense.
                </div>
              </details>
            ) : null}
          </div>

          {signals.length ? (
            <div className="panel">
              <h2>Signals</h2>
              {signals.map((s, i) => (
                <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: ".85rem" }}>
                  <span><span className="tag">{s.kind}</span> {String(s.payload?.price ?? s.payload?.symbol ?? "")}</span>
                  <span className="faint mono" style={{ fontSize: ".72rem" }}>{s.ts.replace("T", " ")}</span>
                </div>
              ))}
            </div>
          ) : null}

          {d.snapshots.length ? (
            <div className="panel">
              <h2>Snapshot history</h2>
              {d.snapshots.map((s) => (
                <div key={s.snapshot_id} className="row" style={{ justifyContent: "space-between", fontSize: ".85rem" }}>
                  <span>{s.as_of} · {s.cycle_label}</span><span className="mono faint">{s.conviction ?? "—"}/5</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
