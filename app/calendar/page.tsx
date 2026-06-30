import { listCalendar, type CalendarEvent } from "../../lib/views/calendar";

export const dynamic = "force-dynamic";

const pad = (n: number) => String(n).padStart(2, "0");
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const statusClass = (s: string) => (s === "monitoring" ? "good" : s === "published" ? "accent" : s === "in_review" ? "warn" : "");

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const now = new Date();
  const m = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;
  const year = Number(m.slice(0, 4));
  const month0 = Number(m.slice(5, 7)) - 1;

  const firstWeekday = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const from = `${year}-${pad(month0 + 1)}-01`;
  const to = `${year}-${pad(month0 + 1)}-${pad(daysInMonth)}`;
  const todayStr = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;

  const prev = month0 === 0 ? `${year - 1}-12` : `${year}-${pad(month0)}`;
  const next = month0 === 11 ? `${year + 1}-01` : `${year}-${pad(month0 + 2)}`;

  const events = await listCalendar({ from, to });
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e);

  const cells: Array<{ day: number; date: string } | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, date: `${year}-${pad(month0 + 1)}-${pad(d)}` });

  return (
    <div className="wrap">
      <div className="spread">
        <div>
          <h1 style={{ margin: 0 }}>Calendar</h1>
          <div className="faint" style={{ fontSize: ".85rem" }}>Known earnings dates across the universe · {events.length} this month</div>
        </div>
        <div className="row">
          <a className="ghost" href={`/calendar?month=${prev}`} style={{ padding: ".3rem .7rem" }}>← {MONTHS[(month0 + 11) % 12].slice(0, 3)}</a>
          <span className="tag" style={{ fontSize: ".95rem" }}>{MONTHS[month0]} {year}</span>
          <a className="ghost" href={`/calendar?month=${next}`} style={{ padding: ".3rem .7rem" }}>{MONTHS[(month0 + 1) % 12].slice(0, 3)} →</a>
          <a href="/universe" className="faint" style={{ marginLeft: ".6rem" }}>universe →</a>
        </div>
      </div>

      <div className="panel" style={{ marginTop: "1rem", padding: ".6rem" }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(7, 1fr)", gap: ".3rem" }}>
          {DOW.map((d) => <div key={d} className="faint" style={{ textAlign: "center", fontSize: ".72rem", padding: ".2rem 0" }}>{d}</div>)}
          {cells.map((cell, i) => {
            if (!cell) return <div key={`b${i}`} />;
            const evs = byDate.get(cell.date) ?? [];
            const isToday = cell.date === todayStr;
            return (
              <div key={cell.date} style={{ minHeight: 88, border: "1px solid var(--border)", borderRadius: 6, padding: ".3rem", background: isToday ? "var(--panel-2)" : "transparent" }}>
                <div className={isToday ? "" : "faint"} style={{ fontSize: ".72rem", fontWeight: isToday ? 600 : 400 }}>{cell.day}</div>
                {evs.map((e) => (
                  <a key={e.company_id} href={`/company/${e.company_id}`} className={`tag ${statusClass(e.coverage_status)}`}
                     style={{ display: "block", marginTop: ".2rem", fontSize: ".72rem", textDecoration: "none" }}
                     title={`${e.legal_name} · ${e.coverage_status}${e.forward_staged ? " · forward staged" : ""}${e.open_areas ? ` · ${e.open_areas} open areas` : ""}`}>
                    {e.forward_staged ? "✓ " : ""}{e.ticker ?? e.legal_name}{e.open_areas ? <span className="mono"> ·{e.open_areas}</span> : null}
                  </a>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="row faint" style={{ marginTop: ".6rem", fontSize: ".75rem", gap: "1rem" }}>
        <span><span className="tag good">monitoring</span></span>
        <span><span className="tag warn">in review</span></span>
        <span><span className="tag accent">published</span></span>
        <span>✓ = forward pass staged · ·N = open areas of interest</span>
      </div>
    </div>
  );
}
