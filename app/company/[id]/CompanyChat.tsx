"use client";
import { useFormStatus } from "react-dom";
import { sendCompanyChat, deepenNow } from "../../actions";

interface Turn { id: string; role: string; message: string; action?: { intent?: string; research_focus?: string[] }; created_at: string }
interface Props { companyId: string; turns: Turn[]; suggestedFocus: string[] }

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? busy : idle}</button>;
}

export default function CompanyChat({ companyId, turns, suggestedFocus }: Props) {
  const lastFocus = [...turns].reverse().find((t) => t.role === "assistant" && (t.action?.research_focus?.length ?? 0) > 0)?.action?.research_focus ?? suggestedFocus;
  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div className="spread"><h2>Ask the desk</h2><span className="faint" style={{ fontSize: ".7rem" }}>from this company's research only · not advice</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: ".5rem", margin: ".6rem 0", maxHeight: 360, overflowY: "auto" }}>
        {turns.length === 0 ? <p className="faint" style={{ fontSize: ".85rem" }}>No questions yet. Ask about the thesis, the numbers, or the risks — or deepen the research on a specific angle.</p> : null}
        {turns.map((t) => (
          <div key={t.id} style={{ alignSelf: t.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%", background: t.role === "user" ? "#1e2633" : "#16181d", border: "1px solid #2a2e37", borderRadius: 12, padding: ".5rem .75rem" }}>
            <div style={{ fontSize: ".6rem", textTransform: "uppercase", letterSpacing: ".1em", opacity: .5, marginBottom: ".2rem" }}>{t.role === "user" ? "You" : "Desk"}</div>
            <div style={{ fontSize: ".9rem", whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{t.message}</div>
          </div>
        ))}
      </div>
      <form action={sendCompanyChat} className="grid" style={{ gap: ".4rem" }}>
        <input type="hidden" name="company_id" value={companyId} />
        <textarea name="message" rows={2} placeholder="Ask about the thesis, numbers, risks…" style={{ width: "100%" }} required />
        <div className="spread"><span className="faint" style={{ fontSize: ".7rem" }} /><Submit idle="Ask" busy="Thinking…" /></div>
      </form>
      <form action={deepenNow} className="row" style={{ marginTop: ".6rem", gap: ".4rem" }}>
        <input type="hidden" name="company_id" value={companyId} />
        <input name="focus" defaultValue={lastFocus.join(", ")} placeholder="focus (comma-separated) — optional" style={{ flex: 1 }} />
        <Submit idle="▶ Deepen research now" busy="Queuing…" />
      </form>
    </div>
  );
}
