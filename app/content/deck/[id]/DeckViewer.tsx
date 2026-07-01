"use client";
import { useState, useEffect, useCallback } from "react";

interface Slide { section: string; title: string; headline: string; bullets: string[]; metric: { label: string; value: string; sub: string } | null; color: string; visual: string }
interface Deck { title: string; subtitle: string; slides: Slide[] }

const BAR: Record<string, string> = { bull: "#34d399", bear: "#f87171", warn: "#fbbf24", info: "#60a5fa", neutral: "#8b93a7" };
const BG: Record<string, string> = { bull: "#0e2a1a", bear: "#2b1416", warn: "#2a2410", info: "#0f1f2e", neutral: "#16181d" };

export default function DeckViewer({ deck, id }: { deck: Deck; id: string }) {
  const [i, setI] = useState(0);
  const n = deck.slides.length;
  const go = useCallback((d: number) => setI((x) => Math.max(0, Math.min(n - 1, x + d))), [n]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "ArrowRight" || e.key === " ") go(1); if (e.key === "ArrowLeft") go(-1); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [go]);

  const sl = deck.slides[i];
  return (
    <div style={{ minHeight: "100vh", background: "#0b0c0f", color: "#e7e9ee" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: ".6rem 1rem", borderBottom: "1px solid #23262d" }}>
        <a href="/content" style={{ color: "#8b93a7", textDecoration: "none", fontSize: ".85rem" }}>← Library</a>
        <span style={{ fontSize: ".8rem", opacity: .7 }}>{deck.title}</span>
        <a href={`/content/deck/${id}/print`} target="_blank" style={{ color: "#8b93a7", textDecoration: "none", fontSize: ".85rem" }}>Print / PDF ↗</a>
      </div>

      <section style={{ position: "relative", minHeight: "82vh", padding: "8vh 9vw", display: "flex", flexDirection: "column", justifyContent: "center", background: BG[sl.color] ?? BG.neutral }}>
        <div style={{ position: "absolute", top: 0, left: 0, height: 8, width: "100%", background: BAR[sl.color] ?? BAR.neutral }} />
        <div style={{ textTransform: "uppercase", letterSpacing: ".15em", fontSize: ".7rem", opacity: .6, marginBottom: "1rem" }}>{sl.section}</div>
        <h2 style={{ fontSize: "2.2rem", margin: "0 0 1rem" }}>{sl.title}</h2>
        <p style={{ fontSize: "1.5rem", lineHeight: 1.4, opacity: .95, margin: "0 0 1.5rem" }}>{sl.headline}</p>
        {sl.metric ? (
          <div style={{ margin: "1rem 0" }}>
            <div style={{ fontSize: "3.2rem", fontWeight: 700 }}>{sl.metric.value}</div>
            <div style={{ fontSize: "1rem", opacity: .7 }}>{sl.metric.label}</div>
            {sl.metric.sub ? <div style={{ opacity: .6 }}>{sl.metric.sub}</div> : null}
          </div>
        ) : null}
        {sl.bullets.length ? <ul style={{ fontSize: "1.15rem", lineHeight: 1.7, paddingLeft: "1.2rem" }}>{sl.bullets.map((b, k) => <li key={k} style={{ margin: ".3rem 0" }}>{b}</li>)}</ul> : null}
      </section>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: ".8rem 1rem" }}>
        <button onClick={() => go(-1)} disabled={i === 0} style={btn(i === 0)}>‹ Prev</button>
        <div style={{ display: "flex", gap: 6 }}>{deck.slides.map((_, k) => <span key={k} onClick={() => setI(k)} style={{ width: 9, height: 9, borderRadius: 9, cursor: "pointer", background: k === i ? "#e7e9ee" : "#3a3f4a" }} />)}</div>
        <button onClick={() => go(1)} disabled={i === n - 1} style={btn(i === n - 1)}>Next ›</button>
      </div>
      <div style={{ textAlign: "center", fontSize: ".75rem", opacity: .5, paddingBottom: "1rem" }}>{i + 1} / {n} · ← → to swipe</div>
    </div>
  );
}

const btn = (disabled: boolean): React.CSSProperties => ({ background: "#16181d", color: "#e7e9ee", border: "1px solid #2a2e37", borderRadius: 8, padding: ".5rem 1rem", cursor: disabled ? "default" : "pointer", opacity: disabled ? .4 : 1 });
