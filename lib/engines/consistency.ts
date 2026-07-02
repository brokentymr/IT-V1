/**
 * Consistency checks (grounding v2 — W6). Cross-check the desk's qualitative claims against the facts
 * computed deterministically from the filing. When a claim's polarity contradicts a computed number,
 * flag it: honest, cheap, and it stops confident-but-wrong prose from surviving. Pure — no LLM.
 */

export interface ComputedFacts {
  fcf_negative?: boolean;
  net_debt?: boolean;
  margin_declining?: boolean; // gross margin down YoY
  revenue_declining?: boolean; // revenue down YoY
  inventory_building?: boolean; // DIO elevated / rising
}

export interface ConsistencyFinding {
  fact: keyof ComputedFacts;
  phrase: string;
  note: string;
}

const CONFLICTS: Array<{ fact: keyof ComputedFacts; phrases: string[]; note: string }> = [
  { fact: "fcf_negative", phrases: ["strong free cash flow", "highly cash generative", "robust fcf", "strong cash generation", "strongly cash generative"], note: "claims strong free cash flow, but computed FCF is negative" },
  { fact: "net_debt", phrases: ["net cash", "cash-rich", "fortress balance sheet", "debt-free", "net-cash position"], note: "claims a net-cash/strong balance sheet, but the company is in net debt" },
  { fact: "margin_declining", phrases: ["margin expansion", "expanding margins", "margins expanding", "improving margins", "margin improvement"], note: "claims margin expansion, but gross margin is down YoY" },
  { fact: "revenue_declining", phrases: ["revenue growth", "top-line growth", "growing revenue", "revenue expansion", "sales growth"], note: "claims revenue growth, but revenue is down YoY" },
  { fact: "inventory_building", phrases: ["lean inventory", "tight inventory", "disciplined inventory", "inventory discipline"], note: "claims lean inventory, but DIO is elevated/rising (a demand-softening signal)" },
];

/** Return the claims whose wording contradicts a computed fact. `text` is the thesis + claim prose. */
export function checkConsistency(facts: ComputedFacts, text: string): ConsistencyFinding[] {
  const lower = text.toLowerCase();
  const out: ConsistencyFinding[] = [];
  for (const c of CONFLICTS) {
    if (!facts[c.fact]) continue;
    const hit = c.phrases.find((p) => lower.includes(p));
    if (hit) out.push({ fact: c.fact, phrase: hit, note: c.note });
  }
  return out;
}

/** Evidence block appended for the desk/verifier when conflicts exist; "" when the claims are clean. */
export function consistencyNote(findings: ConsistencyFinding[]): string {
  if (!findings.length) return "";
  return [
    "=== CONSISTENCY FLAGS (claims vs the computed figures) ===",
    "The narrative below conflicts with the numbers computed from the filing. Treat these as CONTRADICTED",
    "unless reconciled, and correct the claim rather than restating it:",
    ...findings.map((f) => `- ${f.note} (phrase: "${f.phrase}").`),
    "=== END CONSISTENCY FLAGS ===",
  ].join("\n");
}
