import { notFound } from "next/navigation";
import { query } from "../../../../lib/db/pool";
import { listEpisodeNotes } from "../../../../lib/content/notes";
import { addNoteAction, buildEpisodeAction } from "../../../content-actions";

export const dynamic = "force-dynamic";

export default async function StudioPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ err?: string }> }) {
  const { companyId } = await params;
  const { err } = await searchParams;
  const c = await query<{ legal_name: string; primary_ticker: string | null }>("SELECT legal_name, primary_ticker FROM companies WHERE id = $1", [companyId]);
  if (!c.rows[0]) notFound();
  const co = c.rows[0];
  const notes = await listEpisodeNotes(companyId);

  return (
    <div className="wrap">
      <div className="spread">
        <div>
          <h1 style={{ margin: 0 }}>Podcast Studio — {co.primary_ticker ?? co.legal_name}</h1>
          <p className="faint" style={{ marginTop: ".2rem" }}>Both of you add your own notes on the research; “Build episode” weaves them into a script, attributed by author.</p>
        </div>
        <a href={`/company/${companyId}`} className="faint">← company</a>
      </div>

      {err ? <p className="tag warn" style={{ display: "block", marginTop: ".5rem" }}>{decodeURIComponent(err)}</p> : null}

      <div className="grid cols-2" style={{ marginTop: "1rem" }}>
        <div className="panel">
          <h2>Add a note</h2>
          <form action={addNoteAction} className="grid" style={{ gap: ".5rem" }}>
            <input type="hidden" name="company_id" value={companyId} />
            <input name="author" placeholder="Your name (e.g. host)" required />
            <textarea name="note" placeholder="Your take, a question, a story angle…" rows={4} required />
            <div><button type="submit">+ Add note</button></div>
          </form>

          <form action={buildEpisodeAction} style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "1rem" }}>
            <input type="hidden" name="company_id" value={companyId} />
            <button type="submit" disabled={notes.length === 0}>🎙 Build episode from {notes.length} note{notes.length === 1 ? "" : "s"}</button>
            {notes.length === 0 ? <p className="faint" style={{ fontSize: ".78rem" }}>Add at least one note first.</p> : null}
          </form>
        </div>

        <div className="panel">
          <h2>Notes ({notes.length})</h2>
          {notes.length === 0 ? <p className="faint">No notes yet.</p> : null}
          {notes.map((n) => (
            <div key={n.id} style={{ padding: ".4rem 0", borderBottom: "1px solid var(--panel-2)" }}>
              <div className="row" style={{ gap: ".4rem" }}>
                <span className="tag accent">{n.author}</span>
                {n.used_in ? <span className="tag good">in an episode</span> : <span className="tag">unused</span>}
                <span className="faint mono" style={{ fontSize: ".72rem" }}>{n.created_at.replace("T", " ")}</span>
              </div>
              <div style={{ fontSize: ".9rem" }}>{n.note}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
