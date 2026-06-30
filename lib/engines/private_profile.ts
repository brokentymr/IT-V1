/**
 * Private / pre-IPO research profile (Phase 5 follow-up). These names have no SEC filings / XBRL, so
 * the Fundamental engine doesn't apply — instead Perplexity builds a qualitative profile (what they
 * do, funding, valuation, investors, competitors) + a thesis-lite, stored as a snapshot so the
 * Company screen renders it like any other asset. Provenance-stamped; cost goes to the shared ledger.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool";
import { PerplexityClient } from "../sources/perplexity";
import { Thesis } from "../types";

export const ProfileResult = z.object({
  profile: z.object({
    description: z.string(),
    founded: z.string().nullable(),
    headquarters: z.string().nullable(),
    total_funding: z.string().nullable(),
    last_valuation: z.string().nullable(),
    key_investors: z.array(z.string()).default([]),
    competitors: z.array(z.string()).default([]),
    recent: z.string().nullable(),
  }),
  thesis: z.object({
    one_liner: z.string(),
    long_form: z.string(),
    opportunities: z.array(z.string()).default([]),
    risks: z.array(z.string()).default([]),
    conviction: z.number().int().min(1).max(5),
  }),
});
export type ProfileResult = z.infer<typeof ProfileResult>;

export interface ProfileOutcome {
  company_id: string;
  snapshot_id: string | null;
  ok: boolean;
  detail?: string;
}

export async function runPrivateProfile(companyId: string, opts: { client?: PerplexityClient } = {}): Promise<ProfileOutcome> {
  const client = opts.client ?? new PerplexityClient();
  const c = await query<{ legal_name: string; gics_sector: string | null; listing: string; research_focus: string[] | null }>(
    "SELECT legal_name, gics_sector, listing, coverage->'research_focus' AS research_focus FROM companies WHERE id = $1", [companyId],
  );
  const company = c.rows[0];
  if (!company) throw new Error(`company ${companyId} not found`);
  const focus = Array.isArray(company.research_focus) && company.research_focus.length
    ? `\nAdded emphasis (keep the full profile — do not narrow it): give extra weight to and explicitly address ${company.research_focus.map((f) => `"${f}"`).join(", ")} on top of complete coverage.` : "";

  const r = await client.askJSON({
    question: `Build a research profile for ${company.legal_name}${company.gics_sector ? ` (sector: ${company.gics_sector})` : ""}, a ${company.listing === "pre_ipo" ? "pre-IPO" : "private"} company.
Cover: what they do; year founded; HQ; total funding raised; last known valuation; key investors;
main competitors; recent developments. Then a thesis-lite: a one-line take, a short paragraph, the
key opportunities and the key risks, and a conviction 1-5.${focus} Return JSON:
{"profile": {"description": string, "founded": string|null, "headquarters": string|null,
  "total_funding": string|null, "last_valuation": string|null, "key_investors": [string],
  "competitors": [string], "recent": string|null},
 "thesis": {"one_liner": string, "long_form": string, "opportunities": [string], "risks": [string], "conviction": int 1-5}}`,
    schema: ProfileResult, maxTokens: 1500, purpose: "intake.profile",
  });
  if (!r.ok || !r.data) return { company_id: companyId, snapshot_id: null, ok: false, detail: r.missing.join("; ") || r.error };

  const p = r.data;
  await query("INSERT INTO canonical_files (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING", [companyId]);
  const cf = await query<{ id: string }>("SELECT id FROM canonical_files WHERE company_id = $1", [companyId]);
  const today = new Date().toISOString().slice(0, 10);
  const snapshotId = randomUUID();

  await withTransaction(async (client2) => {
    const src = await client2.query<{ id: string }>(
      `INSERT INTO sources (company_id, tier, kind, origin, url, title, retrieved_at, metadata)
       VALUES ($1, 2, 'api', 'Perplexity (Fiscal.ai)', $2, $3, now(), $4) RETURNING id`,
      [companyId, r.citations[0] ?? null, `Profile ${company.legal_name}`, { citations: r.citations }],
    );
    const sourceId = src.rows[0].id;
    const thesis = Thesis.parse({
      one_liner: p.thesis.one_liner,
      long_form: p.thesis.long_form,
      tensions: p.thesis.risks,
      catalysts: p.thesis.opportunities.map((o) => ({ event: o, date: null, expected_impact: "" })),
      invalidation_triggers: p.thesis.risks,
      conviction: p.thesis.conviction,
      positions_held: [],
    });
    const content = {
      profile: { ...p.profile, provenance: [{ claim_id: "profile", source_ref: sourceId }] },
      thesis,
    };
    await client2.query(
      `INSERT INTO canonical_snapshots (snapshot_id, canonical_file_id, company_id, as_of, cycle_label, trigger, conviction, filing_ref, content, diff)
       VALUES ($1,$2,$3,$4,'Profile','manual',$5,null,$6,'{}')`,
      [snapshotId, cf.rows[0].id, companyId, today, p.thesis.conviction, JSON.stringify(content)],
    );
  });

  return { company_id: companyId, snapshot_id: snapshotId, ok: true };
}
