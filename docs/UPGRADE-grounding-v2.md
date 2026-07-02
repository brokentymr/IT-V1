# Grounding v2 — push grounded coverage past 75%
### Spec + audit + build plan for the evidence-depth upgrades
*Grounded coverage trajectory so far: 50% → 58% → 75% (levers + demand extraction). Goal: >90%, with load-bearing claims bound to citable primary sources.*

---

## Principle
Grounded coverage rises when a load-bearing claim moves from "the model's prior" to "backed by a citable source." Two ways to get there: (1) **compute** the fact deterministically from primary data (grounded by construction), or (2) **retrieve** a primary passage and bind the claim to it. Everything below is one of those two.

## Audit — what these plug into (verified in code)
- `SecAdapter.companyFacts(cik)` / `recentFilings(cik)` / `companyIdentity(cik)` fetch **any** entity's XBRL + filings → the customer-health engine can pull a public customer's own numbers. Ticker→CIK resolves via `sec` + `ingestion.ts`.
- **No transcript adapter exists.** Transcript facts will be Perplexity-sourced *with citations* (fallback until a real feed is added). Honest limitation, not raw transcript text.
- `read_through.propagateReadThrough` + `company_links` already model inter-company propagation → the demand-chain read-through reuses this graph.
- XBRL tags currently include current assets/liabilities, debt, capex, interest — but **not** receivables/inventory/payables (needed for the cash-conversion cycle).
- The verifier reasons over one evidence **blob**; there is no passage store yet (needed for claim-level citation binding).

---

## Workstreams (ranked by grounding-ROI)

### W1 — Customer-health / demand-chain engine  ★ flagship
Model each material customer as an entity and read the supplier's demand sustainability out of the **customer's own disclosures**.
- Resolve named customers → ticker/CIK (reuse `company_links`; for a disclosed-but-unnamed customer, use the archetype cohort, e.g. hyperscalers).
- Pull the customer's demand-relevant fundamentals: **capex trajectory + forward capex guidance** (the best memory-demand predictor), the consuming segment, growth/guidance — from their 10-K/10-Q (`SecAdapter` by CIK) + Perplexity for guidance color.
- Emit a **grounded read-through**: customer capex/guidance → extrapolate or invalidate the supplier's demand thesis; and **dated invalidation triggers on the customer's calendar** ("hyperscaler capex cut at [dates] → demand thesis breaks").
- Grounded-% impact: **high** — demand-durability claims (the most load-bearing, most-unverified today) become customer-sourced. Also a genuine variant-perception edge.

### W2 — Earnings-call transcripts
Highest single lift for the least work. Management explains the surprise, quantifies HBM/pricing/capacity, names customers. Grounds the qualitative claims that dominate today's "unverified" set.
- Implementation: Perplexity transcript Q&A with citations (no raw feed yet); upgrade to a real feed later.

### W3 — Multi-year filing history
Pull the last 6–8 quarters so historical-baseline claims (peak margin, cycle amplitude, "highest ever") become **computed facts** instead of memory. Feeds W6 trend metrics.

### W4 — Claim-level citation binding (the substrate)
Redefine grounded coverage as "load-bearing claims carrying a source handle to a specific passage." Give the verifier a **searchable evidence store** (passages with ids) instead of one blob; the desk cites the exact line, the verifier confirms against it. W1/W2/W3 evidence plugs into this store.

### W5 — Deterministic metric expansion (grounded by construction)  ← BUILD FIRST
Free grounding — pure math on primary XBRL:
- **Working-capital / cash-conversion cycle**: DSO, DIO, DPO, CCC (needs receivables/inventory/payables tags). Rising DIO is an early, grounded demand-softening signal — a quantitative cross-check on W1.
- **Segment margins & growth %** from the segment dollars we already extract.
- **Multi-quarter trend metrics** (once W3 lands): revenue CAGR, margin volatility, FCF consistency.

### W6 — Programmatic consistency checks
Cross-check qualitative claims against the computed facts (a "margins expanding" claim vs the actual margin/CCC trend). Agreement → grounded; conflict → contradicted (a feature — honest). Nearly free once W5 metrics exist.

### W7 — Third-party market/pricing data
TrendForce/Gartner ASPs & share to ground pricing/share claims. Lowest priority (paid/hardest); Perplexity-with-citations targeting these as an interim.

---

## Build sequence
1. **W5 (deterministic)** — cheapest, grounded-by-construction, self-contained. **First.**
2. **W4 (citation binding)** — the substrate the retrieval workstreams bind to.
3. **W2 (transcripts)** + **W1 (customer-health, flagship)** — the big evidence lifts, on top of W4.
4. **W6 (consistency)** — once W5 metrics exist.
5. **W3 (history)** and **W7 (third-party)** — slot in; W3 also enriches W5/W6.

Rationale: retrieved evidence (W1/W2) is only as useful as our ability to bind a claim to it (W4); deterministic wins (W5/W6) are cheap and land immediately.
