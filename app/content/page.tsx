import { listContent } from "../../lib/content/store";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = { deck: "📊 Deck", newsletter: "📰 Newsletter", shortform: "🎬 Short-form", podcast: "🎙 Episode" };
const href = (t: string, id: string) => (t === "deck" ? `/content/deck/${id}` : `/content/${id}`);

export default async function ContentLibrary() {
  const items = await listContent();
  return (
    <div className="wrap">
      <div className="spread">
        <h1 style={{ margin: 0 }}>Content Library</h1>
        <div className="row"><a href="/universe" className="faint">universe →</a><span className="muted">{items.length} item{items.length === 1 ? "" : "s"}</span></div>
      </div>
      <p className="faint" style={{ marginTop: ".3rem" }}>Everything the pipeline built from approved research — decks, newsletters, short-form packs, and episodes. All post-checkpoint, sourced, and disclosed.</p>

      <div className="panel" style={{ marginTop: "1rem" }}>
        <table>
          <thead><tr><th>Type</th><th>Title</th><th>Company</th><th>Created</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td><span className="tag">{TYPE_LABEL[it.type] ?? it.type}</span></td>
                <td><a href={href(it.type, it.id)}>{it.title}</a></td>
                <td className="muted"><a href={`/company/${it.company_id}`}>{it.ticker ?? it.legal_name}</a></td>
                <td className="faint mono" style={{ fontSize: ".8rem" }}>{it.created_at.replace("T", " ")}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={4} className="faint">No content yet. Approve a thesis on a company, then “Generate content”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
