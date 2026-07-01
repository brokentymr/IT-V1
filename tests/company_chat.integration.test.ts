/**
 * Per-report chat (Workstream C). Grounding reads the snapshot directly (never assembleSubstance),
 * turns persist, deepen intent surfaces focus, and a budget breach leaves the user's turn saved.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createEphemeralDb, type Ephemeral } from "./helpers/ephemeral-db";
import { setPool } from "../lib/db/pool";
import { answerCompanyChat, loadChatGrounding, loadCompanyChats, recordDeepenTurn, type CompleteFn } from "../lib/engines/company_chat";
import { CostCeilingError } from "../lib/llm/client";

function fakeComplete(answer: { reply: string; intent?: "qa" | "deepen"; research_focus?: string[]; throw?: boolean }): { fn: CompleteFn; counts: { n: number } } {
  const counts = { n: 0 };
  const fn = (async () => {
    counts.n++;
    if (answer.throw) throw new CostCeilingError("ceiling");
    return { reply: answer.reply, intent: answer.intent ?? "qa", research_focus: answer.research_focus ?? [] };
  }) as unknown as CompleteFn;
  return { fn, counts };
}

describe("Company chat (Workstream C)", () => {
  let db: Ephemeral;
  let seq = 0;

  async function seedCompany(withSnapshot: boolean): Promise<string> {
    const tkr = `AA${seq++}`;
    const c = await db.pool.query<{ id: string }>(
      `INSERT INTO companies (legal_name, primary_ticker, identifiers, classification, coverage, coverage_status, gics_sector, listing)
       VALUES ($4,$5,$1,$2,$3,'monitoring','Information Technology','listed') RETURNING id`,
      [{ legal_name: `Corp ${tkr}`, tickers: [tkr] }, {}, { status: "monitoring", positions_held: [], research_focus: ["services growth"] }, `Corp ${tkr}`, tkr],
    );
    const companyId = c.rows[0].id;
    if (!withSnapshot) return companyId;
    const cf = await db.pool.query<{ id: string }>("INSERT INTO canonical_files (company_id) VALUES ($1) RETURNING id", [companyId]);
    const content = {
      thesis: { one_liner: "Margin-led compounder", long_form: "Long form.", invalidation_triggers: ["Net margin < 22%"] },
      fundamentals: { model: { line_items: { revenue: { label: "Revenue", value: 85e9, unit: "USD", yoy: { change_pct: 0.05 } } }, ratios: { net_margin: 0.25 } } },
      scenario: { bands: { revenue: { p10: 74e9, p50: 108e9, p90: 120e9 } } },
      research: { panel: [], verification: { confidence: 0.82, recommendation: "auto", missing_sources: ["earnings call transcript"] } },
    };
    await db.pool.query(
      "INSERT INTO canonical_snapshots (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, content, diff) VALUES ($1,$2,$3,'2026-03-28','10-Q Q2 2026','manual',4,$4,'{}')",
      [randomUUID(), cf.rows[0].id, companyId, JSON.stringify(content)],
    );
    return companyId;
  }

  beforeAll(async () => { db = await createEphemeralDb(); setPool(db.pool); });
  afterAll(async () => { setPool(undefined); await db.drop(); });

  it("grounds on the snapshot directly (never assembleSubstance) and includes desk confidence", async () => {
    const id = await seedCompany(true);
    const g = await loadChatGrounding(id);
    expect(g.snapshotId).not.toBeNull();
    expect(g.grounding).toContain("Margin-led compounder");
    expect(g.grounding).toContain("Desk confidence: 82%");
    expect(g.grounding).toContain("services growth");
    // the module must not depend on the approval-gated content assembler
    const src = readFileSync(new URL("../lib/engines/company_chat.ts", import.meta.url), "utf8");
    expect(src).not.toContain("assembleSubstance");
  });

  it("builds grounding for a company with no snapshot without throwing", async () => {
    const id = await seedCompany(false);
    const g = await loadChatGrounding(id);
    expect(g.snapshotId).toBeNull();
    expect(g.grounding).toContain("No coverage snapshot yet");
  });

  it("qa: persists exactly one user + one assistant turn, one LLM call, pins the snapshot", async () => {
    const id = await seedCompany(true);
    const { fn, counts } = fakeComplete({ reply: "Revenue was $85B, up 5%.", intent: "qa" });
    const r = await answerCompanyChat({ companyId: id, message: "How did revenue do?", complete: fn });
    expect(r.intent).toBe("qa");
    expect(counts.n).toBe(1);
    const turns = await loadCompanyChats(id);
    expect(turns).toHaveLength(2);
    expect(turns.filter((t) => t.role === "user")).toHaveLength(1);
    const assistant = await db.pool.query<{ snapshot_id: string | null }>("SELECT snapshot_id FROM company_chats WHERE company_id=$1 AND role='assistant'", [id]);
    expect(assistant.rows[0].snapshot_id).not.toBeNull();
  });

  it("deepen: surfaces the extracted research focus", async () => {
    const id = await seedCompany(true);
    const { fn } = fakeComplete({ reply: "I'll dig into the China supply chain.", intent: "deepen", research_focus: ["China supply chain"] });
    const r = await answerCompanyChat({ companyId: id, message: "Look deeper at China risk", complete: fn });
    expect(r.intent).toBe("deepen");
    expect(r.research_focus).toEqual(["China supply chain"]);
  });

  it("budget breach: propagates CostCeilingError but keeps the user's turn", async () => {
    const id = await seedCompany(true);
    const { fn } = fakeComplete({ reply: "", throw: true });
    await expect(answerCompanyChat({ companyId: id, message: "anything", complete: fn })).rejects.toBeInstanceOf(CostCeilingError);
    const turns = await loadCompanyChats(id);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("user");
  });

  it("recordDeepenTurn logs the trigger with the enqueued job", async () => {
    const id = await seedCompany(true);
    await recordDeepenTurn({ companyId: id, focus: ["margins"], enqueuedJobId: "job-9" });
    const turns = await loadCompanyChats(id);
    expect(turns).toHaveLength(1);
    expect(turns[0].action.enqueued_job_id).toBe("job-9");
    expect(turns[0].action.research_focus).toEqual(["margins"]);
  });
});
