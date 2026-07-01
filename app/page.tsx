import { listFeed } from "../lib/views/feed";
import { consumerStatus, gapPlain } from "../lib/views/status";

export const dynamic = "force-dynamic";

const BG: Record<string, string> = { good: "#0e2a1a", warn: "#2a2410", info: "#0f1f2e", accent: "#1c1630", neutral: "#16181d" };
const DOT: Record<string, string> = { good: "#34d399", warn: "#fbbf24", info: "#60a5fa", accent: "#a78bfa", neutral: "#8b93a7" };

export default async function Home() {
  const feed = await listFeed();
  return (
    <div style={{ minHeight: "100vh", background: "#0b0c0f", color: "#e7e9ee", maxWidth: 560, margin: "0 auto", padding: "1.2rem 1rem 3rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "1.2rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.6rem", letterSpacing: "-.02em" }}>Investing, together.</h1>
        <a href="/universe" style={{ color: "#4b5162", textDecoration: "none", fontSize: ".72rem" }}>admin ↗</a>
      </div>
      <p style={{ color: "#8b93a7", fontSize: ".9rem", margin: "0 0 1.4rem" }}>The clear read on the companies we follow — a swipe each, no jargon.</p>

      <div style={{ display: "flex", flexDirection: "column", gap: ".8rem" }}>
        {feed.map((c) => {
          const st = consumerStatus(c.coverage_status);
          const gap = gapPlain(c.gap_direction);
          return (
            <a key={c.id} href={`/c/${c.id}`} style={{ textDecoration: "none", color: "inherit" }}>
              <div style={{ background: BG[st.tone] ?? BG.neutral, borderRadius: 16, padding: "1.1rem 1.2rem", border: "1px solid #1e2128" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: ".35rem" }}>
                  <span style={{ fontWeight: 700, fontSize: "1.15rem" }}>{c.ticker ?? c.legal_name}</span>
                  <span style={{ fontSize: ".72rem", color: DOT[st.tone], fontWeight: 600 }}>● {st.label}</span>
                </div>
                <div style={{ fontSize: ".98rem", lineHeight: 1.4, opacity: .95 }}>{c.one_liner ?? (c.coverage_status === "in_research" ? "Building clarity — check back shortly." : "Tap to see what we know.")}</div>
                {gap ? <div style={{ fontSize: ".76rem", color: DOT[gap.tone], marginTop: ".5rem" }}>{gap.text}</div> : null}
              </div>
            </a>
          );
        })}
        {feed.length === 0 && <p style={{ color: "#8b93a7" }}>No companies yet.</p>}
      </div>
    </div>
  );
}
