import { listUniverse, universeFacets } from "../../lib/views/universe";
import AddAsset from "./AddAsset";
import DeleteCompany from "../DeleteCompany";

export const dynamic = "force-dynamic";

const statusTag = (s: string) =>
  s === "monitoring" || s === "published" ? "good" : s === "in_review" ? "warn" : s === "watchlist" ? "" : "accent";

export default async function UniversePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const filters = { q: sp.q, sector: sp.sector, status: sp.status };
  const [rows, facets] = await Promise.all([listUniverse(filters), universeFacets()]);

  return (
    <div className="wrap">
      <div className="spread" style={{ marginBottom: "1rem" }}>
        <h1 style={{ margin: 0 }}>Universe</h1>
        <div className="row">
          <a href="/calendar" className="faint">calendar →</a>
          <a href="/content" className="faint">content →</a>
          <span className="muted">{rows.length} asset{rows.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <form method="get" className="row" style={{ marginBottom: ".8rem" }}>
            <input name="q" placeholder="Search ticker or name…" defaultValue={filters.q ?? ""} style={{ flex: 1 }} />
            <select name="sector" defaultValue={filters.sector ?? ""}>
              <option value="">All sectors</option>
              {facets.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select name="status" defaultValue={filters.status ?? ""}>
              <option value="">All statuses</option>
              {facets.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="ghost" type="submit">Filter</button>
          </form>

          <table>
            <thead><tr><th>Asset</th><th>Sector</th><th>Status</th><th>Conviction</th><th>Thesis</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`/company/${r.id}`}><strong>{r.primary_ticker ?? r.legal_name}</strong></a>
                    {r.listing !== "listed" ? <span className={`tag ${r.listing === "pre_ipo" ? "warn" : "accent"}`} style={{ marginLeft: 6 }}>{r.listing.replace("_", "-")}</span> : null}
                    {r.primary_ticker ? <div className="faint" style={{ fontSize: ".8rem" }}>{r.legal_name}</div> : null}
                  </td>
                  <td className="muted">{r.gics_sector ?? "—"}</td>
                  <td>
                    <span className={`tag ${statusTag(r.coverage_status)}`}>{r.coverage_status}</span>
                    {r.content_enrolled ? <span className="tag accent" style={{ marginLeft: 4 }}>content</span> : null}
                  </td>
                  <td className="mono">{r.conviction ? `${r.conviction}/5` : "—"}</td>
                  <td className="muted" style={{ maxWidth: 280 }}>{r.one_liner ?? <span className="faint">no snapshot yet</span>}</td>
                  <td><DeleteCompany id={r.id} name={r.primary_ticker ?? r.legal_name} variant="row" /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="faint">No assets match.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ alignSelf: "start" }}>
          <AddAsset />
        </div>
      </div>
    </div>
  );
}
