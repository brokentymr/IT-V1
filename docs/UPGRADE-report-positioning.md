# Document 2 — The Report as an Institutional Positioning Document
### Format, presentation, and stance to a State Street / Fidelity bar
*Advisory design — no code changed. Grounded in the Micron (MU) desk output.*

---

## 0. The one sentence that governs everything

**A research report is a decision document, not a description.** Its job is to state a call, defend it with evidence, and tell the reader how to position — with a target, a horizon, catalysts, and what would prove it wrong. Everything else is appendix.

The Micron report fails this at the root: strip the (real) data drama and it has **no rating, no target, no sizing, `catalysts: []`, `conviction: 2/5`**, and its single genuine insight (the Street's price targets are internally incoherent) is stranded in a `claims` array where no reader will ever act on it. It is a well-organized *briefing*. We are being asked to produce *positioning documents*. Those are different genres.

This document specifies the genre: its **structure**, its **stance/voice**, its **presentation rules**, and the **strategic vs tactical** split — then shows Micron rewritten into it.

---

## 1. The two document types (and when each fires)

| | **Strategic Positioning Note** | **Tactical Positioning Note** |
|---|---|---|
| Question it answers | "Do we want to own this franchise over the next several quarters, and at what value?" | "There's an event/print — what do we do *now*?" |
| Trigger | Cold onboard, thesis change, periodic refresh | Filing/earnings, catalyst, price/sentiment anomaly (your existing `COVERAGE_PASS` / anomaly signals) |
| Core content | Franchise quality, multi-quarter thesis, fair-value range, key debates | The delta vs expectations, updated call, entry/target/invalidation, sizing into/around the event |
| Horizon | Quarters–years | Days–one quarter |
| Output | The standing house view | A dated update layered on the standing view |

They **share one thesis and one number set** and differ in depth and time horizon. A filing-triggered pass produces a *tactical* update that references and, when warranted, *amends* the *strategic* note. This maps directly onto your architecture (standing snapshot + filing-triggered coverage) and prevents the surfaces from drifting apart.

---

## 2. The canonical structure (BLUF — bottom line up front)

Ordered by what a PM reads first. **Conclusion leads; evidence supports.**

### §1 — VERDICT BOX (the 10-second read)
The single most important missing element. A scannable header that delivers the entire call before any prose:

```
┌───────────────────────────────────────────────────────────────────────┐
│ MICRON  (MU)          STRATEGIC: Constructive · TACTICAL: Trim into print │
│ Conviction 3/5 (Medium)              Horizon: 2–4 quarters               │
│ Fair value:  Bear $78  ·  Base $145  ·  Bull $240   (base ≈ +12% / spot) │
│ Risk / reward: 1 : 1.8         Suggested size: HALF (high-variance cyclical)│
│ Next catalysts: FQ4 print [Sep 24] · HBM4 qual news [4Q] · China ruling [ongoing]│
│ Variant view: Street targets are internally incoherent — the debate is    │
│               DURABILITY, and we think margins hold ~2 quarters, not the cycle│
└───────────────────────────────────────────────────────────────────────┘
```
Every field here is absent from the current output. This box *is* the product; the rest justifies it.

### §2 — VARIANT VIEW ("why we're right and consensus is wrong")
2–4 sentences: the differentiated thesis and the edge, evidence-linked. **If there is no edge, say so** — "we are consensus; no differentiated view; pass/hold" is a valuable, honest answer. This is the section that ends decision-free hedging. On Micron it writes itself from the insight the desk already found and buried (§6 below).

### §3 — THESIS
The argument that defends the call — a causal chain, not a description. Each load-bearing claim carries a citation. This is where the "what's really happening" (memory supercycle / HBM shortage economics) lives, as an *argument for the stance*, not a neutral summary.

### §4 — KEY DEBATES ("what has to be true") + OUR ANSWER
The 2–3 questions the thesis stands on, each with the bull case, the bear case, and **the desk's adjudicated lean + evidence.** This is where judgment disagreements are *owned*, not averaged away. For Micron the central debate is explicit: *Is 84.9% gross margin durable or a peak-cycle spike?* — with the desk taking a side.

### §5 — THE NUMBERS (model + scenarios + valuation bridge)
The grounded driver tree → scenario table (bull/base/bear with the *assumptions that produce each*) → the bridge from base case to the price target. Reconciled and sourced (see Doc 1 §5). No standalone Monte Carlo floating free of the thesis.

### §6 — CATALYSTS & CALENDAR
Dated events that move the thesis, each with expected direction and why it matters. **Never empty for a covered name.** This is the tactical spine.

### §7 — RISKS & WHAT WOULD CHANGE OUR MIND
The invalidation triggers (already the strongest part of today's output) promoted here and framed as monitorable, plus position-level risk (sizing, liquidity, correlation to the book).

### §8 — EVIDENCE / SOURCING APPENDIX + DISCLOSURES
Every material claim cited; groundedness/confidence disclosed; compliance language. The audit trail that separates institutional research from a chat answer.

---

## 3. Presentation principles (the "how it reads")

1. **BLUF everywhere.** Every section leads with its conclusion, then supports it. The current report's best idea is buried on line ~34 of a claims array; in the new format it leads §2. **Rule to encode:** any claim that is *high-confidence AND non-obvious AND decision-relevant* is promoted upward; generic context sinks to appendix.
2. **One fact base, every number sourced and consistent.** No "peak margin was 47% / 59% / 47.4%" across the same document (Doc 1's Fact Store enforces this). A single inconsistent number destroys institutional trust faster than a wrong call.
3. **Declarative stance, calibrated conviction.** Institutional voice is accountable: "**We are constructive; we'd trim into the print.**" Not "high-reward, high-variance setup." Uncertainty is expressed as a *calibrated conviction number and a scenario range*, not as hedging prose. Conviction 2/5 with no call is a non-answer; conviction 2/5 *with* a "Pass — no edge" is a real one.
4. **Insight elevated, context subordinated.** The domain depth (TSV packaging moat, CXMT/EUV constraints, node cost curves) is real and good — but it must be *marshaled into the argument*, not laid out as an encyclopedia. Context that doesn't move the call goes to appendix.
5. **Strategic vs tactical clearly separated.** The reader must always know whether they're reading the multi-quarter franchise view or the trade-around-the-event view. The verdict box carries both lines; the body flags which sections are which.
6. **Consistency of call across all surfaces.** The swipe card, the newsletter, the deck, and the operator report must carry the **same stance, same target, same catalysts** — differing only in depth. This is a governance rule for the content spider (`assemble.ts` / `generate.ts`): all surfaces render from the *one* decision object (Doc 1 §6), never re-derive it. Today they risk drift.
7. **Visual hierarchy as a first-class deliverable.** Verdict box, scenario table, catalyst calendar, and the risk/reward as *scannable visual objects* — this is where your color-coded deck concept becomes a genuine institutional asset, not decoration.

---

## 4. Stance calibration — the spectrum we must hit

The report must land somewhere real on this spectrum and say so:

```
 STRONG CONVICTION LONG ── CONSTRUCTIVE ── NEUTRAL/IN-LINE ── CAUTIOUS ── AVOID/SHORT
        (size up)         (own, trim risk)   (pass, no edge)   (underweight)  (size down/short)
```

The failure to occupy a point on this line — the perpetual "it's complicated, high variance" — is the single biggest gap between the current output and a Fidelity note. **Neutral is allowed; mush is not.** "We pass — the debate is durability, we have no differentiated read on it, and it's priced for perfection" is a professional, publishable stance.

---

## 5. Micron: before → after (concrete)

**Before (today's actual output):** one-liner is about whether the data is a bug; `catalysts: []`; conviction 2/5; no target; no sizing; the one real insight buried; four lenses contradicting each other on the headline fact.

**After (same facts, positioning-document format):**

- **Verdict box:** Constructive strategically / Trim-into-print tactically; conviction 3/5; fair value Bear $78 / Base $145 / Bull $240; R:R ~1:1.8; half-size; dated catalysts; variant-view line.
- **§2 Variant view:** *"Consensus is internally incoherent: the ~$1,382 average target implies ~366x forward P/E on the Street's own $3.78 next-quarter EPS — which itself implies an ~85% sequential EPS collapse. The market is simultaneously pricing a crash (estimates) and euphoria (targets). Our read: the crash is overstated near-term — HBM/AI shortage economics hold margins for ~2 more quarters — but the euphoria is right to fear the cycle. We're constructive but disciplined: own the supercycle, refuse to underwrite it as structural."*
- **§4 Key debate:** *Is 84.9% gross margin durable?* Bull (structural HBM mix-shift, supply discipline, AI content growth) vs Bear (no moat, Samsung/SK Hynix capacity, depreciation ramp, China) — **desk lean: peak-cyclical, ~2 quarters of durability, not structural**, with the evidence for that lean.
- **§5 Numbers:** driver-tree model (DRAM/NAND/HBM bit-volume × ASP × cost/bit) producing the three scenarios and the valuation bridge to the targets — reconciled, not two disconnected number sets.
- **§6 Catalysts:** the print, HBM4 qualification news, China policy, monthly DRAM/NAND spot pricing (TrendForce) — dated.
- **§7 Invalidation:** the existing strong triggers (Samsung HBM3E re-qual, ASP −20% QoQ, revenue < P10), promoted and monitorable.

Same underlying facts. The difference is entirely **stance, structure, and the decision to commit** — which is the whole job.

---

## 6. What to encode where (mapping to the system)

- The **decision object** (Doc 1 §6) is the single source of truth; every surface renders from it (`lib/views/*`, `lib/content/assemble.ts`).
- The **verdict box** and **scenario table** become structured fields, not prose — so the deck/newsletter/swipe surfaces render them consistently.
- A **publish gate on stance:** `autocommit.ts` should refuse to publish a covered name with an empty `variant_view`, empty `catalysts`, or no stance — the same way it already refuses on a standing contradiction. "Description-only" becomes structurally unpublishable.
- **House voice** (approachable, value-focused, risk-managed) is the *skin*; the institutional structure above is the *skeleton*. The consumer swipe layer is the strategic note *compressed*, never a different call.

---

## 7. Acceptance test (how we know a report is good)

A report passes only if a PM can answer all six from the top of the page in under a minute:
1. **What's the call**, and how strongly?
2. **What's the edge** — where is consensus wrong, or do we have none?
3. **What's it worth** — bull/base/bear, and how did we get there?
4. **What do I do around the next catalyst**, and when is it?
5. **What would prove me wrong?**
6. **How much do I own**, given the variance?

The Micron report answers **zero of six** today. That is the gap, precisely measured.

---

*End Document 2. Companion: Document 1 — pipeline re-architecture (the machine that produces this document).*
