import { notFound } from "next/navigation";
import { getCompanyDetail } from "../../../lib/views/company";
import { runCoverage, runProfile, setAnalytics, setContent, approveThesis, addLink, setLinkStatus, deleteLink } from "../../actions";

export const dynamic = "force-dynamic";

const LINK_TYPES = ["competitor", "supplier", "customer", "parent", "subsidiary", "jv_partner", "shared_end_market", "thematic_peer", "macro_correlated"];

const fmtB = (n?: number | null) =>
  n == null ? "—" : Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${n.toFixed(0)}`;
const pctf = (n?: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const dirTag = (d: string) => (d === "up" ? "good" : d === "down" ? "bad" : "");

interface Band { p10: number; p50: number; p90: number }
interface Profile { description?: string; founded?: string | null; headquarters?: string | null; total_funding?: string | null; last_valuation?: string | null; key_investors?: string[]; competitors?: string[]; recent?: string | null }
interface SnapContent {
  profile?: Profile;
  fundamentals?: { model?: { fiscal_period?: string; line_items?: Record<string, { label: string; value: number; unit: string; yoy?: { change_pct: number } | null }>; ratios?: Record<string, number> } };
  scenario?: { target_period?: string | null; bands?: { revenue?: Band; net_income?: Band; eps?: Band }; beat_probability?: { revenue: number | null; eps: number | null }; sensitivity?: Array<{ driver: string; metric: string; contribution: number }>; watch_items?: string[] };
  market_context?: { consensus?: Record<string, unknown> | null; analyst_view?: Record<string, unknown> | null };
  thesis?: { one_liner?: string; long_form?: string; tensions?: string[]; invalidation_triggers?: string[]; conviction?: number };
  hypotheses?: { drivers?: Array<{ name: string; metric: string; direction: string; framing: string; impact_pct: { bear: number; base: number; bull: number } }> };
  research?: {
    panel?: Array<{ lens: string; summary: string; key_points?: string[]; risks?: string[]; confidence: number }>;
    verification?: { confidence: number; missing_sources?: string[]; recommendation: string; verdicts?: Array<{ claim: string; status: string; note: string }> };
  };
}
interface Diff { metrics?: Array<{ key: string; label: string; prior: number | null; current: number; change_pct: number | null; direction: string }> }

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getCompanyDetail(id);
  if (!d) notFound();
  const { header: h, latest, approval, relationships, feed, signals, areas } = d;
  const content = (latest?.content ?? {}) as SnapContent;
  const diff = (latest?.diff ?? {}) as Diff;
  const sc = content.scenario;
  const thesis = approval?.edited_thesis ? { ...content.thesis, ...(approval.edited_thesis as object) } : content.thesis;

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
          <a href="/jobs" className="faint">watch pipeline →</a>
        </div>
      </div>

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
            {latest ? (
              <div style={{ marginTop: ".8rem", borderTop: "1px solid var(--border)", paddingTop: ".8rem" }}>
                {approval ? (
                  <div className="row"><span className="tag good">✓ approved</span><span className="faint">{approval.approved_at.replace("T", " ")} · {approval.approved_by}</span></div>
                ) : (
                  <details>
                    <summary style={{ cursor: "pointer" }} className="muted">Approve thesis (human checkpoint)</summary>
                    <form action={approveThesis} style={{ marginTop: ".6rem" }} className="grid">
                      <input type="hidden" name="company_id" value={h.id} /><input type="hidden" name="snapshot_id" value={latest.snapshot_id} />
                      <input name="one_liner" placeholder="(optional) edit one-liner" defaultValue="" />
                      <textarea name="note" placeholder="(optional) approval note" rows={2} />
                      <div><button type="submit">Approve</button></div>
                    </form>
                  </details>
                )}
              </div>
            ) : null}
          </div>

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
                <p className="tag warn" style={{ display: "block", marginBottom: ".5rem" }}>⚠ Low confidence — flagged for human review before publishing.</p>
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
                <thead><tr><th>Line item</th><th>Value</th><th>YoY</th><th>Δ vs prior snapshot</th></tr></thead>
                <tbody>
                  {Object.values(content.fundamentals.model.line_items).map((li) => {
                    const dm = diff.metrics?.find((m) => m.label === li.label);
                    return (
                      <tr key={li.label}>
                        <td>{li.label}</td>
                        <td className="mono">{li.unit === "USD/shares" ? li.value.toFixed(2) : fmtB(li.value)}</td>
                        <td className="mono muted">{li.yoy ? pctf(li.yoy.change_pct) : "—"}</td>
                        <td>{dm && dm.change_pct != null ? <span className={`tag ${dirTag(dm.direction)}`}>{dm.direction} {pctf(dm.change_pct)}</span> : <span className="faint">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {content.fundamentals.model.ratios ? <p className="muted" style={{ fontSize: ".88rem" }}>Margins: {Object.entries(content.fundamentals.model.ratios).map(([k, v]) => `${k.replace("_", " ")} ${pctf(v)}`).join(" · ")}</p> : null}
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
          </div>
        </div>

        {/* Sidebar: market context, signals, feed, history */}
        <div>
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
