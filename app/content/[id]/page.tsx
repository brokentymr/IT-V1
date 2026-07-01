import { notFound, redirect } from "next/navigation";
import { getContentItem } from "../../../lib/content/store";
import type { Newsletter } from "../../../lib/engines/newsletter";
import type { ShortFormPack } from "../../../lib/engines/shortform";
import type { PodcastScript } from "../../../lib/engines/podcast";

export const dynamic = "force-dynamic";

export default async function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const item = await getContentItem(id);
  if (!item) notFound();
  if (item.type === "deck") redirect(`/content/deck/${id}`);

  return (
    <div className="wrap">
      <div className="spread">
        <h1 style={{ margin: 0, fontSize: "1.4rem" }}>{item.title}</h1>
        <a href="/content" className="faint">← Library</a>
      </div>

      {item.type === "newsletter" ? (
        <div className="panel" style={{ marginTop: "1rem" }}>
          <p className="faint" style={{ fontSize: ".78rem" }}>Substack-ready Markdown. {"{{slide:…}}"} markers show where the deck slides inset.</p>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", lineHeight: 1.6 }}>{(item.body as Newsletter).markdown}</pre>
        </div>
      ) : null}

      {item.type === "shortform" ? (
        <div style={{ marginTop: "1rem" }}>
          {(item.body as ShortFormPack).clips.map((c, i) => (
            <div key={i} className="panel">
              <div className="row" style={{ gap: ".4rem" }}><span className="tag accent">clip {i + 1}</span>{c.platform.map((p) => <span key={p} className="tag">{p}</span>)}</div>
              <h3 style={{ margin: ".4rem 0 .2rem" }}>{c.hook}</h3>
              <p className="muted" style={{ marginTop: 0 }}>{c.point_in_one_breath}</p>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: ".3rem .8rem", fontSize: ".85rem" }}>
                <div><span className="faint">Visual: </span>{c.visual_idea}</div>
                <div><span className="faint">On-screen: </span>{c.on_screen_text}</div>
                <div><span className="faint">Caption: </span>{c.suggested_caption}</div>
                <div className="faint">{c.disclosure_caption}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {item.type === "podcast" ? (() => {
        const s = item.body as PodcastScript;
        return (
          <div style={{ marginTop: "1rem" }}>
            <div className="panel">
              <h2>Metadata</h2>
              <p className="muted"><span className="faint">Hosts: </span>{s.metadata.authors.join(" & ") || "—"} · <span className="faint">cycle </span>{s.metadata.cycle_label}</p>
              <p className="muted" style={{ fontSize: ".88rem" }}><span className="faint">Spoken disclosure (read aloud): </span>{s.metadata.spoken_disclosure}</p>
            </div>
            {s.segments.map((seg, i) => (
              <div key={i} className="panel">
                <div className="spread"><h3 style={{ margin: 0 }}>{seg.topic}</h3></div>
                <p style={{ marginTop: ".3rem" }}>{seg.point}</p>
                {seg.facts.length ? <ul className="list-tight muted">{seg.facts.map((f, k) => <li key={k}>{f}</li>)}</ul> : null}
                {seg.sentiment_signal_context ? <p className="faint" style={{ fontSize: ".82rem" }}>{seg.sentiment_signal_context}</p> : null}
                {seg.contributions.map((c, k) => (
                  <div key={k} style={{ borderLeft: "2px solid var(--accent, #60a5fa)", paddingLeft: ".6rem", margin: ".3rem 0" }}>
                    <span className="tag accent">{c.author}</span> <span className="muted">{c.take}</span>
                  </div>
                ))}
              </div>
            ))}
            {s.facts_appendix.length ? (
              <div className="panel">
                <h2>Facts &amp; figures appendix</h2>
                <ul className="list-tight muted">{s.facts_appendix.map((f, i) => <li key={i}>{f.figure} <span className="faint">— {f.source}</span></li>)}</ul>
              </div>
            ) : null}
          </div>
        );
      })() : null}

      {item.disclosure ? <p className="faint" style={{ fontSize: ".75rem", marginTop: "1rem" }}>{item.disclosure}</p> : null}
    </div>
  );
}
