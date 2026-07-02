/**
 * Provenance config (control P3). Config-not-code: the quarantine thresholds live here.
 *
 * - matchToleranceRel: a currency token that equals a verified claim value within this relative
 *   tolerance (2%) is admitted as grounded — it restates a figure the pipeline computed.
 * - barredKinds: which numeric kinds are subject to quarantine. Default: currency only. Percent/ratio
 *   threshold tokens (e.g. "Net margin < 22%") are admitted; they are the desk's own bar, not a claim.
 * - maxScaleMultiple: invalidation triggers are FORWARD thresholds, not current values, so a threshold
 *   need not equal any computed figure. A currency threshold is admitted as a legitimate, measurable
 *   bar as long as it stays within this multiple of the model's own largest currency figure; only a
 *   figure that is implausible vs the model scale (e.g. trillions when the company earns tens of
 *   billions, or a unit mismatch) is quarantined. Set >1 so ordinary downside/upside bars pass.
 * - minExtractionConfidence: floor for treating an extracted trigger token as verified on match.
 */
export interface ProvenanceConfig {
  enabled: boolean;
  matchToleranceRel: number;
  barredKinds: string[];
  maxScaleMultiple: number;
  minExtractionConfidence: number;
}

export const PROVENANCE_CONFIG: ProvenanceConfig = {
  enabled: true,
  matchToleranceRel: 0.02,
  barredKinds: ["currency"],
  maxScaleMultiple: 10,
  minExtractionConfidence: 0,
};
