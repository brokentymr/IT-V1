/**
 * Deck → standalone printable HTML (Phase 8). The Content Library and the /print route render the deck
 * as one color-coded slide per page (print-to-PDF ready — the memo's PDF form). Self-contained (inline
 * CSS) so it renders identically in the browser and under a headless print.
 */
import type { Deck, Slide } from "../engines/deck";

const COLORS: Record<string, { bg: string; bar: string }> = {
  bull: { bg: "#0e2a1a", bar: "#34d399" },
  bear: { bg: "#2b1416", bar: "#f87171" },
  warn: { bg: "#2a2410", bar: "#fbbf24" },
  info: { bg: "#0f1f2e", bar: "#60a5fa" },
  neutral: { bg: "#16181d", bar: "#8b93a7" },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));

export function slideHtml(sl: Slide): string {
  const c = COLORS[sl.color] ?? COLORS.neutral;
  const metric = sl.metric ? `<div class="metric"><div class="mval">${esc(sl.metric.value)}</div><div class="mlabel">${esc(sl.metric.label)}</div>${sl.metric.sub ? `<div class="msub">${esc(sl.metric.sub)}</div>` : ""}</div>` : "";
  const bullets = sl.bullets.length ? `<ul>${sl.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
  return `<section class="slide" style="background:${c.bg}">
    <div class="bar" style="background:${c.bar}"></div>
    <div class="sec">${esc(sl.section)}</div>
    <h2>${esc(sl.title)}</h2>
    <p class="headline">${esc(sl.headline)}</p>
    ${metric}${bullets}
  </section>`;
}

export function deckHtml(deck: Deck): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(deck.title)}</title>
<style>
  *{box-sizing:border-box} body{margin:0;background:#0b0c0f;color:#e7e9ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .slide{position:relative;min-height:100vh;padding:8vh 9vw;display:flex;flex-direction:column;justify-content:center;page-break-after:always}
  .bar{position:absolute;top:0;left:0;height:8px;width:100%}
  .sec{text-transform:uppercase;letter-spacing:.15em;font-size:.7rem;opacity:.6;margin-bottom:1rem}
  h2{font-size:2.2rem;margin:0 0 1rem} .headline{font-size:1.5rem;line-height:1.4;opacity:.95;margin:0 0 1.5rem}
  ul{font-size:1.15rem;line-height:1.7;padding-left:1.2rem} li{margin:.3rem 0}
  .metric{margin:1rem 0} .mval{font-size:3.2rem;font-weight:700} .mlabel{font-size:1rem;opacity:.7} .msub{opacity:.6}
  @media print{.slide{min-height:100vh}}
</style></head><body>${deck.slides.map(slideHtml).join("")}</body></html>`;
}
