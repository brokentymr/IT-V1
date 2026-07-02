/**
 * Risk <-> trigger join checks (control P10). Risks and invalidation triggers are ONE typed system:
 * a risk should name the trigger that would confirm it, and a trigger should be referenced by a risk
 * AND carry a verifiable disclosure (what to look for, and where). This pure, deterministic pass (no
 * LLM — modeled on consistency.ts) flags the joins that don't hold. Blocking findings hold auto-publish;
 * warnings are informational. Missing inputs degrade to [] (never fabricate a finding).
 */
import type { Risk, InvalidationTrigger } from "../types";

export interface RiskJoinFinding {
  kind: "risk_without_trigger" | "trigger_without_risk" | "trigger_without_disclosure";
  severity: "warn" | "block";
  id: string;
  note: string;
}

/**
 * Check the risk/trigger join. Rules:
 *  - a risk with a null/unresolved linked_trigger_id => warn (risk_without_trigger)
 *  - a trigger referenced by NO risk.linked_trigger_id => block (trigger_without_risk)
 *  - a trigger with empty disclosure AND null source_ref => block (trigger_without_disclosure)
 * Empty inputs => []. Deterministic; order follows risks then triggers.
 */
export function checkRiskTriggerJoin(
  risks: Risk[],
  triggers: InvalidationTrigger[],
): RiskJoinFinding[] {
  const out: RiskJoinFinding[] = [];
  const rs = risks ?? [];
  const ts = triggers ?? [];
  if (!rs.length && !ts.length) return out;

  const triggerIds = new Set(ts.map((t) => t.id));
  const referenced = new Set(
    rs.map((r) => r.linked_trigger_id).filter((id): id is string => !!id && triggerIds.has(id)),
  );

  for (const r of rs) {
    if (!r.linked_trigger_id || !triggerIds.has(r.linked_trigger_id)) {
      out.push({
        kind: "risk_without_trigger",
        severity: "warn",
        id: r.id,
        note: `risk "${r.title}" has no resolved invalidation trigger`,
      });
    }
  }

  for (const t of ts) {
    if (!referenced.has(t.id)) {
      out.push({
        kind: "trigger_without_risk",
        severity: "block",
        id: t.id,
        note: `trigger "${t.condition}" is not linked from any risk`,
      });
    }
    if (!t.disclosure.trim() && t.source_ref == null) {
      out.push({
        kind: "trigger_without_disclosure",
        severity: "block",
        id: t.id,
        note: `trigger "${t.condition}" has no disclosure and no source ref (unverifiable)`,
      });
    }
  }

  return out;
}

/** Filter to the blocking findings (these hold auto-publish, like a consistency conflict). */
export function blocks(findings: RiskJoinFinding[]): RiskJoinFinding[] {
  return findings.filter((f) => f.severity === "block");
}
