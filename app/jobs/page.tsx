import { getJobs, getRecentCoverage, getFeeds } from "../../lib/views/jobs";

export const dynamic = "force-dynamic";

const jobTag = (s: string) =>
  s === "completed" ? "good" : s === "active" ? "accent" : s === "failed" || s === "cancelled" ? "bad" : s === "created" || s === "retry" ? "warn" : "";

export default async function JobsPage() {
  const [jobs, coverage, feeds] = await Promise.all([getJobs(), getRecentCoverage(), getFeeds()]);
  const active = jobs.filter((j) => j.state === "created" || j.state === "active").length;

  return (
    <div className="wrap">
      <div className="spread" style={{ marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Pipeline</h1>
        <span className="muted">{active} queued/running</span>
      </div>

      <div className="grid cols-2">
        <div>
          <div className="panel">
            <h2>Job queue</h2>
            <table>
              <thead><tr><th>Job</th><th>Asset</th><th>State</th><th>Created</th><th>Done</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="mono" style={{ fontSize: ".82rem" }}>{j.name}{j.accession ? <div className="faint" style={{ fontSize: ".72rem" }}>{j.accession}</div> : null}</td>
                    <td>{j.ticker ?? "—"}</td>
                    <td><span className={`tag ${jobTag(j.state)}`}>{j.state}</span></td>
                    <td className="faint mono" style={{ fontSize: ".75rem" }}>{j.created_on?.replace("T", " ")}</td>
                    <td className="faint mono" style={{ fontSize: ".75rem" }}>{j.completed_on?.replace("T", " ") ?? "—"}</td>
                  </tr>
                ))}
                {jobs.length === 0 && <tr><td colSpan={5} className="faint">No jobs yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Recent coverage runs</h2>
            <table>
              <thead><tr><th>Asset</th><th>Cycle</th><th>Conviction</th><th>As of</th></tr></thead>
              <tbody>
                {coverage.map((c) => (
                  <tr key={c.snapshot_id}>
                    <td><a href={`/company/${c.company_id}`}>{c.ticker ?? c.legal_name}</a></td>
                    <td className="muted">{c.cycle_label}</td>
                    <td className="mono">{c.conviction ?? "—"}/5</td>
                    <td className="faint">{c.as_of}</td>
                  </tr>
                ))}
                {coverage.length === 0 && <tr><td colSpan={4} className="faint">No coverage snapshots yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>Alerts (TradingView)</h2>
            {feeds.alerts.map((a, i) => (
              <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: ".85rem" }}>
                <span><a href={`/company/${a.company_id}`}>{a.ticker ?? "—"}</a> <span className="tag">{a.label}</span> {a.detail}</span>
                <span className="faint mono" style={{ fontSize: ".72rem" }}>{a.ts.replace("T", " ")}</span>
              </div>
            ))}
            {feeds.alerts.length === 0 && <p className="faint">No alerts.</p>}
          </div>

          <div className="panel">
            <h2>News notes</h2>
            <div style={{ maxHeight: 420, overflow: "auto" }}>
              {feeds.news.map((n, i) => (
                <div key={i} style={{ padding: ".35rem 0", borderBottom: "1px solid var(--panel-2)" }}>
                  <div className="row" style={{ gap: ".4rem" }}>
                    <a href={`/company/${n.company_id}`}>{n.ticker ?? "—"}</a>
                    <span className={`tag ${n.kind === "read_through" ? "accent" : ""}`}>{n.kind === "read_through" ? "read-through" : n.detail}</span>
                    {n.score != null ? <span className="mono faint" style={{ fontSize: ".72rem" }}>{n.score}</span> : null}
                  </div>
                  <div style={{ fontSize: ".85rem" }}>{n.label}</div>
                </div>
              ))}
              {feeds.news.length === 0 && <p className="faint">No news notes.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
