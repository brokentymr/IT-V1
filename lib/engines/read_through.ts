/**
 * Read-through pass (spec §4.6). When a material event hits asset A, walk A's relationship
 * links and assess each neighbor for a material read-through; record a read_through news_note
 * on each affected asset. Depth-limited (default 2 hops) and materiality-gated at every hop;
 * cross-sector links are followed.
 */
import { randomUUID } from "node:crypto";
import { query } from "../db/pool";
import { NewsNote } from "../types";
import { MONITOR_CONFIG, type MonitorConfig } from "../config/monitor";
import type { NewsAnalyzer } from "./analyzer";

export interface ReadThroughOrigin {
  noteId: string; // the primary note (origin_event_ref)
  companyId: string;
  companyName: string;
  headline: string;
  summary: string;
  category: string;
  sourceRef: string | null;
}

export interface ReadThroughOutcome {
  notesCreated: number;
  reached: string[]; // affected company ids
  escalated: string[]; // ids that received a MAJOR-band read-through (→ sentiment escalation, spec §4.6)
}

const materialityScore = (m: "low" | "medium" | "high"): number =>
  m === "high" ? 80 : m === "medium" ? 55 : 30;

export async function propagateReadThrough(
  analyzer: NewsAnalyzer,
  origin: ReadThroughOrigin,
  cfg: MonitorConfig = MONITOR_CONFIG,
): Promise<ReadThroughOutcome> {
  const out: ReadThroughOutcome = { notesCreated: 0, reached: [], escalated: [] };
  const visited = new Set<string>([origin.companyId]);

  interface Node { companyId: string; companyName: string; headline: string; summary: string; category: string; depth: number }
  let frontier: Node[] = [{
    companyId: origin.companyId, companyName: origin.companyName,
    headline: origin.headline, summary: origin.summary, category: origin.category, depth: 0,
  }];

  while (frontier.length) {
    const next: Node[] = [];
    for (const node of frontier) {
      if (node.depth >= cfg.readThrough.maxDepthHops) continue;

      const links = await query<{
        to_company_id: string; type: string; direction_note: string | null;
        cross_sector: boolean; to_name: string; to_sector: string | null;
      }>(
        `SELECT cl.to_company_id, cl.type, cl.direction_note, cl.cross_sector,
                c.legal_name AS to_name, c.gics_sector AS to_sector
           FROM company_links cl JOIN companies c ON c.id = cl.to_company_id
          WHERE cl.from_company_id = $1`,
        [node.companyId],
      );

      for (const link of links.rows) {
        if (visited.has(link.to_company_id)) continue;

        const j = await analyzer.judgeReadThrough({
          event: { company: node.companyName, headline: node.headline, summary: node.summary, category: node.category },
          neighbor: { company: link.to_name, gics_sector: link.to_sector },
          link: { type: link.type, direction_note: link.direction_note, cross_sector: link.cross_sector },
        });

        const score = materialityScore(j.materiality);
        // materiality gate: must be judged material AND clear the flag floor
        if (!j.material || score < cfg.readThrough.materialityFloor) continue;
        visited.add(link.to_company_id);
        out.reached.push(link.to_company_id);

        const noteId = randomUUID();
        const status = score >= cfg.bands.escalate ? "escalated" : "flagged";
        if (status === "escalated") out.escalated.push(link.to_company_id);
        const content = NewsNote.parse({
          id: noteId,
          company_id: link.to_company_id,
          detected_at: new Date().toISOString(),
          source_ref: origin.sourceRef ?? origin.noteId,
          headline: `Read-through: ${node.headline}`,
          summary: j.expected_effect,
          category: node.category,
          origin: { kind: "read_through", origin_event_ref: origin.noteId, origin_company_id: node.companyId, link_type: link.type },
          importance_score: score,
          importance_rationale: `Read-through via ${link.type} link from ${node.companyName}`,
          impact_analysis: {
            forward_outlook: j.expected_effect,
            thesis_effect: j.thesis_effect,
            invalidation_trigger_hit: null,
            sentiment_effect: "",
            estimated_magnitude: j.materiality,
          },
          read_through: [],
          status,
        });
        await query(
          `INSERT INTO news_notes (id, company_id, detected_at, source_ref, category, origin_kind, origin_company_id, importance_score, status, content)
           VALUES ($1,$2,now(),$3,$4,'read_through',$5,$6,$7,$8)`,
          [noteId, link.to_company_id, origin.sourceRef, node.category, node.companyId, score, status, content],
        );
        out.notesCreated++;

        // recurse from the affected asset (carries the read-through effect as the new event)
        next.push({
          companyId: link.to_company_id, companyName: link.to_name,
          headline: node.headline, summary: j.expected_effect, category: node.category,
          depth: node.depth + 1,
        });
      }
    }
    frontier = next;
  }
  return out;
}
