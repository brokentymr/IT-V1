"use client";
import { useState, useEffect, useCallback } from "react";

interface Card { kind: string; title: string; headline: string; bullets: string[]; color: string; metric: { value: string; label: string } | null }
interface Props {
  id: string; ticker: string | null; legal_name: string;
  status: { label: string; tone: string };
  building: boolean; progress: Array<{ step: string; status: string; detail: string }>;
  deckId: string | null; cards: Card[];
}

const BAR: Record<string, string> = { bull: "#34d399", bear: "#f87171", warn: "#fbbf24", info: "#60a5fa", neutral: "#8b93a7" };
const BG: Record<string, string> = { bull: "#0e2a1a", bear: "#2b1416", warn: "#2a2410", info: "#0f1f2e", neutral: "#16181d" };
const TONE: Record<string, string> = { good: "#34d399", warn: "#fbbf24", info: "#60a5fa", accent: "#a78bfa", neutral: "#8b93a7" };
const STEP_ICON: Record<string, string> = { ok: "✓", failed: "✕", skipped: "–" };

export default function ConsumerDeck(p: Props) {
  const [i, setI] = useState(0);
  const n = p.cards.length;
  const go = useCallback((d: number) => setI((x) => Math.max(0, Math.min(n - 1, x + d))), [n]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "ArrowRight" || e.key === " ") go(1); if (e.key === "ArrowLeft") go(-1); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [go]);
  const [touchX, setTouchX] = useState<number | null>(null);

  const sl = p.cards[i];
  return (
    <div style={{ minHeight: "100vh", background: "#0b0c0f", color: "#e7e9ee", maxWidth: 560, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: ".7rem 1rem" }}>
        <a href="/" style={{ color: "#8b93a7", textDecoration: "none", fontSize: ".9rem" }}>‹ Home</a>
        <span style={{ fontSize: ".78rem", color: TONE[p.status.tone] ?? "#8b93a7", fontWeight: 600 }}>{p.status.label}</span>
        <a href={`/company/${p.id}`} style={{ color: "#4b5162", textDecoration: "none", fontSize: ".72rem" }}>the details ↗</a>
      </div>

      {p.building && p.progress.length ? (
        <div style={{ padding: ".4rem 1rem", display: "flex", gap: ".5rem", flexWrap: "wrap", justifyContent: "center" }}>
          {p.progress.map((s) => (
            <span key={s.step} style={{ fontSize: ".7rem", color: s.status === "ok" ? "#34d399" : s.status === "failed" ? "#f87171" : "#8b93a7" }}>{STEP_ICON[s.status] ?? "•"} {s.step}</span>
          ))}
        </div>
      ) : null}

      <section
        onTouchStart={(e) => setTouchX(e.touches[0].clientX)}
        onTouchEnd={(e) => { if (touchX != null) { const dx = e.changedTouches[0].clientX - touchX; if (dx < -40) go(1); if (dx > 40) go(-1); setTouchX(null); } }}
        style={{ position: "relative", minHeight: "70vh", margin: "0 1rem", borderRadius: 20, padding: "2.2rem 1.6rem", display: "flex", flexDirection: "column", justifyContent: "center", background: BG[sl.color] ?? BG.neutral, boxShadow: "0 10px 40px rgba(0,0,0,.4)" }}
      >
        <div style={{ position: "absolute", top: 0, left: 0, height: 6, width: "100%", background: BAR[sl.color] ?? BAR.neutral, borderRadius: "20px 20px 0 0" }} />
        <div style={{ textTransform: "uppercase", letterSpacing: ".14em", fontSize: ".68rem", opacity: .55, marginBottom: ".8rem" }}>{sl.title}</div>
        {sl.metric ? <div style={{ marginBottom: "1rem" }}><div style={{ fontSize: "2.8rem", fontWeight: 800 }}>{sl.metric.value}</div><div style={{ opacity: .6, fontSize: ".9rem" }}>{sl.metric.label}</div></div> : null}
        <p style={{ fontSize: "1.55rem", lineHeight: 1.35, fontWeight: 600, margin: "0 0 1.2rem" }}>{sl.headline}</p>
        {sl.bullets.length ? <ul style={{ fontSize: "1.02rem", lineHeight: 1.6, paddingLeft: "1.1rem", opacity: .9 }}>{sl.bullets.map((x, k) => <li key={k} style={{ margin: ".3rem 0" }}>{x}</li>)}</ul> : null}
      </section>

      <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "1rem" }}>
        {p.cards.map((_, k) => <span key={k} onClick={() => setI(k)} style={{ width: 8, height: 8, borderRadius: 8, cursor: "pointer", background: k === i ? "#e7e9ee" : "#3a3f4a" }} />)}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", padding: "0 1.4rem 1.4rem" }}>
        <button onClick={() => go(-1)} disabled={i === 0} style={btn(i === 0)}>‹</button>
        {p.deckId ? <a href={`/content/deck/${p.deckId}`} style={{ ...btn(false), textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Open the full deck</a> : <span style={{ fontSize: ".72rem", opacity: .4, alignSelf: "center" }}>{i + 1} / {n}</span>}
        <button onClick={() => go(1)} disabled={i === n - 1} style={btn(i === n - 1)}>›</button>
      </div>
    </div>
  );
}

const btn = (disabled: boolean): React.CSSProperties => ({ background: "#16181d", color: "#e7e9ee", border: "1px solid #2a2e37", borderRadius: 12, padding: ".6rem 1.2rem", fontSize: "1.1rem", cursor: disabled ? "default" : "pointer", opacity: disabled ? .35 : 1 });
