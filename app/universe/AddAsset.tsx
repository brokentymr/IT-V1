"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

interface Entity { name: string; ticker: string | null; listing: string; exchange: string | null; sector: string | null; rationale: string; verified?: boolean; verification?: string; cik?: string | null }
interface AddResult { name: string; company_id?: string | null; listing?: string; result: string; research?: string; detail?: string }

const listTag = (l: string) => (l === "listed" ? "good" : l === "pre_ipo" ? "warn" : "accent");

export default function AddAsset() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const [focus, setFocus] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<"" | "resolve" | "add">("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<AddResult[] | null>(null);

  async function resolve() {
    setBusy("resolve"); setError(""); setResults(null); setEntities(null);
    try {
      const res = await fetch("/api/intake/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!data.entities?.length) { setError(data.error ? `No matches (${data.error})` : "No companies resolved — try rephrasing."); }
      setEntities(data.entities ?? []);
      setFocus(data.research_focus ?? []);
      setPicked(new Set((data.entities ?? []).map((_: Entity, i: number) => i)));
    } catch { setError("Resolve failed."); }
    finally { setBusy(""); }
  }

  async function add() {
    if (!entities) return;
    setBusy("add"); setError("");
    const selected = entities.filter((_, i) => picked.has(i));
    try {
      const res = await fetch("/api/intake/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entities: selected, research_focus: focus }) });
      const data = await res.json();
      setResults(data.results ?? []);
      setEntities(null); setText("");
      router.refresh();
    } catch { setError("Add failed."); }
    finally { setBusy(""); }
  }

  const toggle = (i: number) => setPicked((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });

  return (
    <div>
      <h2>Add assets</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: ".88rem" }}>Describe what to add — a company, several names, or a sector to drill into. The agent resolves tickers + listing status.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} style={{ width: "100%" }}
        placeholder={'e.g. "Nvidia and its main competitors" · "SpaceX" · "semiconductor equipment makers"'} />
      <div className="row" style={{ marginTop: ".5rem" }}>
        <button onClick={resolve} disabled={!text.trim() || busy !== ""}>{busy === "resolve" ? "Resolving…" : "Resolve"}</button>
        {entities && entities.length > 0 ? <button className="ghost" onClick={add} disabled={busy !== "" || picked.size === 0}>{busy === "add" ? "Adding…" : `Add selected (${picked.size})`}</button> : null}
      </div>
      {error ? <p className="muted" style={{ color: "var(--warn)", fontSize: ".85rem" }}>{error}</p> : null}

      {entities && entities.length > 0 ? (
        <div style={{ marginTop: ".7rem" }}>
          <h3>Research focus</h3>
          <input value={focus.join(", ")} onChange={(e) => setFocus(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            placeholder="(none) — e.g. device price increases, demand destruction" style={{ width: "100%" }} />
          <p className="faint" style={{ fontSize: ".72rem", margin: ".2rem 0 .6rem" }}>Extra weight on these topics across each asset&apos;s thesis / drivers / profile — layered on top of the full analysis, not a replacement for breadth.</p>
          <h3>Proposed ({entities.length})</h3>
          {entities.map((e, i) => (
            <label key={i} style={{ display: "flex", gap: ".5rem", padding: ".4rem 0", borderBottom: "1px solid var(--panel-2)", cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} style={{ marginTop: ".2rem" }} />
              <div style={{ flex: 1 }}>
                <div className="row" style={{ gap: ".4rem" }}>
                  <strong>{e.name}</strong>
                  {e.ticker ? <span className="tag mono">{e.ticker}</span> : null}
                  <span className={`tag ${listTag(e.listing)}`}>{e.listing.replace("_", "-")}</span>
                  {e.verified ? <span className="tag good" title={e.verification}>✓ EDGAR-verified</span> : <span className="tag warn" title={e.verification}>unverified</span>}
                  {e.sector ? <span className="tag">{e.sector}</span> : null}
                </div>
                <div className="faint" style={{ fontSize: ".8rem" }}>{e.rationale}</div>
                {e.verification ? <div className="faint" style={{ fontSize: ".72rem" }}>{e.verification}</div> : null}
              </div>
            </label>
          ))}
          <p className="faint" style={{ fontSize: ".75rem", marginTop: ".4rem" }}>Listed → SEC ingest + coverage run. Private/pre-IPO → record + Perplexity profile. Research auto-runs on add.</p>
        </div>
      ) : null}

      {results ? (
        <div style={{ marginTop: ".7rem" }}>
          <h3>Added</h3>
          {results.map((r, i) => (
            <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: ".85rem", padding: ".25rem 0" }}>
              <span>{r.company_id ? <a href={`/company/${r.company_id}`}>{r.name}</a> : r.name}</span>
              <span><span className={`tag ${r.result === "failed" ? "bad" : "good"}`}>{r.result}</span>{r.research && r.research !== "none" ? <span className="tag accent" style={{ marginLeft: 4 }}>{r.research}</span> : null}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
