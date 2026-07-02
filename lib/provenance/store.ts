/**
 * Numeric-claims persistence (control P3). Writes into the separate mutable `numeric_claims` table
 * (migration 0019) inside the CALLER'S transaction — the snapshot append and its claims commit atomically.
 */
import type { PoolClient } from "pg";
import type { VerifiedClaim } from "./numeric";
import { extractNumbers } from "./numeric";

export interface PersistNumericClaimsInput {
  snapshotId: string;
  companyId: string;
  sourceRef: string | null;
  verified: VerifiedClaim[];
  triggerClaims: { admitted: string[]; quarantined: string[] };
}

export interface NumericClaimRow {
  id: string;
  snapshot_id: string;
  company_id: string;
  source_ref: string | null;
  value: number | null;
  unit: string | null;
  period: string | null;
  source_doc: string | null;
  source_locator: string | null;
  extraction_confidence: number;
  verified: boolean;
}

/** Persist the verified located claims plus the extracted invalidation-trigger tokens (verified per match). */
export async function persistNumericClaims(client: PoolClient, input: PersistNumericClaimsInput): Promise<void> {
  const { snapshotId, companyId, sourceRef, verified, triggerClaims } = input;

  for (const v of verified) {
    await client.query(
      `INSERT INTO numeric_claims
         (snapshot_id, company_id, source_ref, value, unit, period, source_doc, source_locator, extraction_confidence, verified)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [snapshotId, companyId, sourceRef, v.value, v.unit, null, null, v.source_locator, 1.0, true],
    );
  }

  // Trigger tokens: admitted triggers are grounded (verified=true), quarantined ones are not.
  const persistTriggerTokens = async (trigger: string, verifiedFlag: boolean) => {
    for (const tok of extractNumbers(trigger)) {
      await client.query(
        `INSERT INTO numeric_claims
           (snapshot_id, company_id, source_ref, value, unit, period, source_doc, source_locator, extraction_confidence, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [snapshotId, companyId, sourceRef, tok.value, tok.unit, null, trigger, "trigger", 0, verifiedFlag],
      );
    }
  };
  for (const t of triggerClaims.admitted) await persistTriggerTokens(t, true);
  for (const t of triggerClaims.quarantined) await persistTriggerTokens(t, false);
}

export async function loadNumericClaims(client: PoolClient, snapshotId: string): Promise<NumericClaimRow[]> {
  const { rows } = await client.query<NumericClaimRow>(
    `SELECT id, snapshot_id, company_id, source_ref, value, unit, period, source_doc, source_locator,
            extraction_confidence, verified
       FROM numeric_claims WHERE snapshot_id = $1 ORDER BY created_at ASC`,
    [snapshotId],
  );
  return rows;
}
