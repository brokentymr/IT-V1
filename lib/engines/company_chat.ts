/**
 * Per-report chat (Workstream C). Grounded Q&A over a company's canonical research — and the classifier
 * behind the "Deepen research now" trigger. Grounding is read DIRECTLY from the latest snapshot (never
 * via the approval-gated content assembler, which throws pre-publish — exactly when a user opens the
 * chat to deepen). The
 * assistant answers ONLY from that grounding; if the user asks to dig further it returns intent="deepen"
 * with the extracted focus, which the action layer turns into a coverage re-run.
 */
import { z } from "zod";
import { query } from "../db/pool";
import { completeJSON, type CompleteOptions } from "../llm/client";

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  message: string;
  action: { intent?: string; research_focus?: string[]; enqueued_job_id?: string | null };
  created_at: string;
}

export const ChatAnswer = z.object({
  reply: z.string(),
  intent: z.enum(["qa", "deepen"]).default("qa"),
  research_focus: z.array(z.string()).default([]),
});
export type ChatAnswer = z.infer<typeof ChatAnswer>;

export type CompleteFn = <T>(o: CompleteOptions<T>) => Promise<T>;

interface SnapContent {
  thesis?: { one_liner?: string; long_form?: string; invalidation_triggers?: string[] };
  fundamentals?: { model?: { line_items?: Record<string, { label: string; value: number; unit: string; yoy?: { change_pct: number } | null }>; ratios?: Record<string, number> } };
  scenario?: { bands?: { revenue?: { p10: number; p50: number; p90: number } } };
  research?: { verification?: { confidence?: number; recommendation?: string; missing_sources?: string[] } };
}

export interface ChatGrounding { grounding: string; snapshotId: string | null; company: { legal_name: string; ticker: string | null } }

/** Read the latest snapshot directly (approval-independent) into a compact grounding block. */
export async function loadChatGrounding(companyId: string): Promise<ChatGrounding> {
  const c = await query<{ legal_name: string; primary_ticker: string | null; gics_sector: string | null; research_focus: string[] }>(
    "SELECT legal_name, primary_ticker, gics_sector, COALESCE(coverage->'research_focus','[]') AS research_focus FROM companies WHERE id = $1",
    [companyId],
  );
  if (!c.rows[0]) return { grounding: "Company not found.", snapshotId: null, company: { legal_name: "", ticker: null } };
  const co = c.rows[0];
  const company = { legal_name: co.legal_name, ticker: co.primary_ticker };

  const s = await query<{ snapshot_id: string; as_of: string; cycle_label: string; content: SnapContent }>(
    "SELECT snapshot_id, to_char(as_of,'YYYY-MM-DD') AS as_of, cycle_label, content FROM canonical_snapshots WHERE company_id = $1 ORDER BY as_of DESC, created_at DESC LIMIT 1",
    [companyId],
  );
  if (!s.rows[0]) {
    return { grounding: `Company: ${co.legal_name} (${co.primary_ticker ?? "unlisted"}) — sector ${co.gics_sector ?? "unknown"}. No coverage snapshot yet.`, snapshotId: null, company };
  }
  const snap = s.rows[0];
  const content = snap.content ?? {};
  const lines: string[] = [
    `Company: ${co.legal_name} (${co.primary_ticker ?? "unlisted"}) — sector ${co.gics_sector ?? "unknown"}.`,
    `Latest cycle: ${snap.cycle_label} (as of ${snap.as_of}).`,
  ];
  const th = content.thesis;
  if (th?.one_liner) lines.push(`Thesis: ${th.one_liner}`);
  if (th?.long_form) lines.push(th.long_form);
  if (th?.invalidation_triggers?.length) lines.push(`Invalidation triggers: ${th.invalidation_triggers.join("; ")}`);

  const li = content.fundamentals?.model?.line_items;
  if (li) {
    const items = Object.values(li).slice(0, 6).map((x) => `${x.label} ${x.unit === "USD/shares" ? x.value.toFixed(2) : x.value}${x.yoy ? ` (YoY ${(x.yoy.change_pct * 100).toFixed(1)}%)` : ""}`);
    if (items.length) lines.push(`Figures: ${items.join("; ")}`);
  }
  const ratios = content.fundamentals?.model?.ratios;
  if (ratios && Object.keys(ratios).length) lines.push(`Margins/ratios: ${Object.entries(ratios).map(([k, v]) => `${k.replace(/_/g, " ")} ${(v * 100).toFixed(1)}%`).join(", ")}`);
  const rev = content.scenario?.bands?.revenue;
  if (rev) lines.push(`Next-period revenue scenario p10/p50/p90: ${rev.p10}/${rev.p50}/${rev.p90}.`);
  const v = content.research?.verification;
  if (v && typeof v.confidence === "number") lines.push(`Desk confidence: ${(v.confidence * 100).toFixed(0)}% (${v.recommendation ?? "?"}). Missing sources: ${(v.missing_sources ?? []).join(", ") || "none noted"}.`);
  if (co.research_focus?.length) lines.push(`Standing research focus: ${co.research_focus.join(", ")}.`);

  return { grounding: lines.join("\n"), snapshotId: snap.snapshot_id, company };
}

/** The last `limit` turns, oldest→newest (for the transcript). */
export async function loadCompanyChats(companyId: string, limit = 20): Promise<ChatTurn[]> {
  const { rows } = await query<ChatTurn>(
    `SELECT id, role, message, action, created_at FROM (
        SELECT id, role, message, action, to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, created_at AS ts
          FROM company_chats WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2
      ) t ORDER BY ts ASC`,
    [companyId, limit],
  );
  return rows;
}

export interface ChatResult { reply: string; intent: "qa" | "deepen"; research_focus: string[]; user_turn_id: string; assistant_turn_id: string }

export async function answerCompanyChat(o: { companyId: string; message: string; complete?: CompleteFn }): Promise<ChatResult> {
  const complete = o.complete ?? completeJSON;
  const g = await loadChatGrounding(o.companyId);

  const u = await query<{ id: string }>(
    "INSERT INTO company_chats (company_id, snapshot_id, role, message) VALUES ($1,$2,'user',$3) RETURNING id",
    [o.companyId, g.snapshotId, o.message],
  );

  const recent = await loadCompanyChats(o.companyId, 6);
  const history = recent.map((t) => `${t.role}: ${t.message}`).join("\n");

  const prompt = `You are the analyst desk's assistant for ${g.company.legal_name}${g.company.ticker ? ` (${g.company.ticker})` : ""}. Answer the user's question using ONLY the research context below. If the context does not contain the answer, say you don't have that in the current research yet rather than speculating or inventing figures. Be concise, plain-language, and never give buy/sell advice. If the user is asking us to dig deeper, research something further, or update coverage, set intent="deepen" and put the specific topic(s) into research_focus.

RESEARCH CONTEXT:
${g.grounding}

RECENT CONVERSATION:
${history || "(none)"}

USER: ${o.message}

Return JSON: {"reply": string, "intent": "qa"|"deepen", "research_focus": [string]}`;

  const ans = await complete({ prompt, schema: ChatAnswer, model: "claude-sonnet-4-6", maxTokens: 700, purpose: "company_chat.answer" });

  const a = await query<{ id: string }>(
    "INSERT INTO company_chats (company_id, snapshot_id, role, message, action) VALUES ($1,$2,'assistant',$3,$4) RETURNING id",
    [o.companyId, g.snapshotId, ans.reply, JSON.stringify({ intent: ans.intent, research_focus: ans.research_focus })],
  );

  return { reply: ans.reply, intent: ans.intent, research_focus: ans.research_focus, user_turn_id: u.rows[0].id, assistant_turn_id: a.rows[0].id };
}

/** Record that a deepen run was triggered (shown in the transcript). A null job id means the enqueue
 *  was deduped against an in-flight pass — say so truthfully rather than promising a fresh run. */
export async function recordDeepenTurn(o: { companyId: string; focus: string[]; enqueuedJobId: string | null }): Promise<string> {
  const focusList = o.focus.length ? `: ${o.focus.join(", ")}` : "";
  const msg = o.enqueuedJobId === null
    ? `A coverage pass is already running for this company; your focus${focusList ? ` (${o.focus.join(", ")})` : ""} has been saved and applies to the next cycle.`
    : `Deepening research${focusList} — the desk is re-running coverage; check back shortly.`;
  const { rows } = await query<{ id: string }>(
    "INSERT INTO company_chats (company_id, role, message, action) VALUES ($1,'assistant',$2,$3) RETURNING id",
    [o.companyId, msg, JSON.stringify({ intent: "deepen", research_focus: o.focus, enqueued_job_id: o.enqueuedJobId })],
  );
  return rows[0].id;
}
