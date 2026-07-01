# Document 1 — Pipeline Re-Architecture
### From a retrieval-poor summarizer to a grounded analyst
*Advisory design — no code changed. Grounded in the Micron (MU) desk output.*

---

## 0. The diagnosis, stated plainly

The Micron report is the whole system in miniature. Read as a machine trace, it exposes five root failures — none of which are prompt-tuning problems. They are **architectural**.

| # | Failure | Evidence from the MU run | Consequence |
|---|---------|--------------------------|-------------|
| R1 | **Retrieval poverty** | 11 of 13 verification claims came back `unverified`. The only 2 `supported` were "consensus says X" and "Morningstar fair value $455" — the two things it actually fetched. | The desk reasons from the model's memory, not from evidence. Everything specific is ungrounded. |
| R2 | **Prior-anchoring / surprise-rejection** | 3 of 4 lenses called a *true, reported* 84.9% gross margin "physically impossible / data error" at 0.82–0.92 confidence. | The system is least trustworthy exactly when news matters most (regime change). |
| R3 | **Adjudication-by-averaging** | Sector lens (0.74) confidently validated the number; three lenses rejected it. The "manager" blended toward "unverified" instead of ruling. Peak gross margin was quoted as 47%, 59%, and 47.4% by three lenses — never reconciled. | No single fact base. Contradictions survive into the final artifact. |
| R4 | **Ungrounded quantification** | Driver impacts (`HBM base +12%`) have no model beneath them; the Monte Carlo (P50 $53B vs a reported $41.5B) is a separate RNG that never reconciles to the drivers. | "Precision theater" — numbers that look modeled but aren't. |
| R5 | **No decision stage** | `catalysts: []`, `positions_held: []`, `conviction: 2/5`, no target, no sizing. | The pipeline stops at *description*. It never does the analyst's job. |

The current agentic shape — **manager → 4 parallel lenses → synthesize → adversarial verify → loop** — is a good *reasoning* skeleton wrapped around an *impoverished evidence base* and *missing the stages on either end* (grounded retrieval before, decision after). We are optimizing the debate while starving it of facts and never forcing it to a verdict.

**The re-architecture is not "better prompts." It is: ground the inputs, make surprise investigable, force adjudication, model the numbers for real, and add a decision engine.**

---

## 1. Target architecture (the seven-stage grounded desk)

```
                          ┌─────────────────────────────────────────────┐
   NEW  ▶  (1) RETRIEVAL PLANNER  ──►  (2) EVIDENCE / GROUNDED FACT STORE │
          decides what THIS name    normalized, period-labeled,          │
          needs, then fetches it    citation-tagged facts + docs         │
                          └───────────────────────┬─────────────────────┘
                                                  ▼
                    (3) ANALYST PANEL (4 lenses)  — reason ONLY over cited evidence
                                                  ▼
   NEW  ▶  (4) ANOMALY / SURPRISE INVESTIGATOR  — "this deviates hugely → WHY?"
                                                  ▼
   REBUILT ▶ (5) ADJUDICATOR (head of research) — resolves FACT disputes via retrieval,
                                                   OWNS judgment disputes as bull/bear
                                                  ▼
   REBUILT ▶ (6) FINANCIAL MODEL SPINE  — driver tree → revenue → margin → EPS → value;
                                          scenarios & Monte Carlo are OUTPUTS of it
                                                  ▼
   NEW  ▶  (7) POSITIONING / DECISION ENGINE  — rating, target, R/R, catalysts, sizing,
                                                variant view, invalidation triggers
                                                  ▼
          VERIFICATION-WITH-REPAIR loops back into (1) to close load-bearing gaps
```

Stages 3 and the verify step exist today. **Stages 1, 2, 4, 7 are net-new; stages 5 and 6 are rebuilds.** Below, each is specified against the current code.

---

## 2. Principle R1 → Evidence-first: *"no material claim without a citation"*

**Today (`research.ts`):** `runResearch(ctx)` passes a single `contextBlock(evidence)` — essentially one filing's text plus a Perplexity blurb — to four lenses that then assert whatever they "know." Verification runs *after* and can only rubber-stamp the two fetched facts.

**Change: invert the flow. Build the evidence base BEFORE reasoning, and bind every load-bearing claim to a source handle.**

### 2.1 Retrieval Planner (new — `lib/engines/retrieval_planner.ts`)
A cheap up-front agent that, given the company + the trigger (filing, event, cold onboard), outputs a **retrieval plan**: the specific documents and datapoints this thesis will stand on. For Micron that plan *must* include the seven things the desk itself listed as `missing_sources` and then never fetched:
- Multi-year 10-K/10-Q history (for baselines — the desk needed FY22–25 margins and had none)
- The earnings-call **transcript** (where "84.9% and why" is explained by management)
- Third-party **pricing/share data** (TrendForce/Gartner DRAM–HBM ASPs)
- Consensus estimate **detail** (not just a summary line)
- Segment disclosures, capex guidance, China concentration, credit/debt schedule

### 2.2 Expanded source adapters (extend `lib/sources/`)
We have `SecAdapter`, `PerplexityFinance`, `PriceAdapter`, Fiscal.ai. Gaps to close, roughly in ROI order:
1. **Full filing text + history**, not a single XBRL extraction. (Also structurally prevents the "one number, no baseline" trap.)
2. **Transcripts** (earnings calls, investor days) — the single highest-value unused source. Surprises get *explained* on the call.
3. **Market/industry data** (pricing, share, capacity) — turns "unverified ~25% share" into a cited fact.
4. **Consensus detail** — line-item estimates, revisions, dispersion (this is where the real MU insight lived).

### 2.3 Grounded Fact Store (new — `migrations/00XX_fact_store.sql`, `lib/engines/fact_store.ts`)
A per-company table of **extracted, normalized, period-labeled, citation-tagged facts**:
`(company_id, metric, value, unit, period, as_reported|normalized, source_ref, confidence)`.
Lenses draw facts from here instead of each re-deriving them from memory. This **structurally kills R3's "three different peak-margin numbers"**: there is one canonical `gross_margin FY2022 = X (source: 10-K 2022)`, and every lens cites the same one.

**Rule enforced in code:** a claim entering the *confident* body of the report must carry a `source_ref`. Ungrounded assertions are not deleted — they are **quarantined** into an explicit `analyst_prior` bucket ("believed true, not yet sourced"), which (a) never inflates confidence and (b) becomes retrieval targets. This is the difference between an analyst's sourced note and an LLM's confident recall.

---

## 3. Principle R2 → Surprise is a signal, not an error

This is the Micron failure, and it deserves a dedicated mechanism because it is the difference between "world's best" and "dangerous."

### 3.1 Anomaly / Surprise Investigator (new — `lib/engines/surprise.ts`, invoked inside `deepen.ts`)
Before the panel concludes, a deterministic **variance detector** compares each material metric against (a) the company's own history and (b) consensus. A large deviation (e.g., GM 39% → 84.9%; revenue +346% YoY) does **not** trigger a "flag as implausible" verdict. It triggers a **mandatory investigation**:

> "This is a +45pt gross-margin surprise. Assume the print is real. **Why is it happening?** Retrieve the transcript and segment detail. Is it durable or peak-cyclical? What does consensus expect next?"

The correct analyst reflex is *curiosity toward the surprise*, and it must be wired in, not hoped for. On the MU run this single loop converts the entire wasted "is it a bug" report into the actual thesis: **memory supercycle, HBM/AI shortage economics, Micron as margin king, and the real debate — durability.**

### 3.2 Reorient the deepen loop's escalation (`deepen.ts` / `desk_manager.ts`)
Today the manager escalates toward *re-running opinions* (`relens`, `bump_tier`). Re-point escalation at **closing grounded gaps and explaining surprises**: spend budget on retrieval + investigation of load-bearing unknowns, not on asking the same lenses again at a higher tier. "Enrich twice at the same confidence" already hints the bottleneck is informational — make that the default instinct.

---

## 4. Principle R3 → Adjudication, not averaging

**Today (`desk_manager.ts` + `synthesize`):** the manager picks enrich/reanalyze/conclude and the synthesizer blends four lens outputs. Disagreement is averaged away.

**Change: the head of research must RULE, and the type of disagreement determines how.**

- **Fact disputes** (is 84.9% real? is share 25%?) are **retrieval questions, not debates.** The adjudicator routes the disputed claim to the Fact Store / a targeted fetch and *rules* on the evidence. It must not average "real" and "impossible."
- **Judgment disputes** (is the margin durable?) are **owned, not blended.** The report explicitly carries the bull and bear with the desk's adjudicated lean and the evidence for it — this becomes the "key debates" section of the output (Doc 2, §4).
- **Load-bearing tracking:** the manager maintains the set of claims the thesis *depends on*. It may not `conclude` while any load-bearing claim is (a) unresolved across lenses or (b) ungrounded. This replaces today's "conclude when the confidence float looks okay."

---

## 5. Principle R4 → A real model as the quantitative spine

**Today (`fundamental_research.ts`):** driver hypotheses with `impact_pct {bear,base,bull}` and a separate Monte Carlo. Neither is derived; they don't reconcile (drivers imply single-digit swings, the MC spans −52% to +28%).

**Change: one grounded model engine; scenarios and Monte Carlo are its outputs.**
- A **driver tree** anchored to reported/historical figures: `units × ASP × mix → segment revenue → gross margin → operating margin → EPS`. For Micron that is DRAM vs NAND vs HBM, bit-volume × ASP × cost/bit.
- **Bear/base/bull are scenarios on that model** — each is a named set of input assumptions, and the model computes the financials. The impact of "HBM demand" is then *derived*, not asserted, and it *reconciles* to the scenario bands by construction.
- **Monte Carlo** (if retained) samples the model's genuinely uncertain inputs (ASP, volume, mix) with vols estimated from the now-available history — so P10/P50/P90 are engine outputs, not a labelled RNG. A P50 must sit sensibly relative to the current print, with the assumptions that produce it visible.
- **If something can't be modeled, it is a labeled qualitative risk — never a fake percentage.**

---

## 6. Principle R5 → A decision engine as a first-class stage

**Today:** the pipeline ends at description. `autocommit.ts` publishes based on a confidence float; there is no stage that produces a *call*.

**Change: add a terminal Positioning/Decision engine (`lib/engines/positioning.ts`)** that converts the adjudicated analysis + model into a decision object:

```
{
  stance,                 // Long / Short / Pass / Hold (+ Strategic vs Tactical)
  conviction,             // calibrated, with basis
  price_target: {bull, base, bear},   // from the model, §5
  expected_return, risk_reward,       // asymmetry, explicit
  horizon,
  sizing_guidance,        // given variance (the MU "high variance" made concrete)
  variant_view,           // what we believe that consensus doesn't, + evidence — or "we ARE consensus → pass"
  catalysts: [{event, date, expected_direction}],   // never empty for a covered name
  invalidation_triggers,  // already strong today — promoted to decision inputs
}
```

The **`variant_view` field is mandatory and is the quality gate**: the desk must state its edge or explicitly declare it has none (a legitimate, valuable answer — "no edge, pass"). This is what ends the decision-free hedging. On Micron, the variant view writes itself from the *real* insight the desk already found and buried: the Street's $1,382 target implies ~366x forward P/E and its own consensus implies an ~85% sequential EPS collapse — the debate is entirely *durability*, and that is a positionable view.

---

## 7. Principle R6 → Verification that repairs

**Today:** `verify()` emits verdicts + a `missing_sources` to-do list, then stops. The to-do list *is the analyst's job, itemized as undone.*

**Change:** an `unverified` **load-bearing** claim automatically triggers targeted retrieval (back to Stage 1) to ground or drop it, iterating until resolved or explicitly abandoned. Confidence is redefined as **grounded-coverage of load-bearing claims**, not a model self-report. The deepen budget is spent on the highest-leverage gaps, not on re-litigating opinions.

---

## 8. Principle R7 → Calibration & self-audit (how we actually reach "world's best")

You cannot converge on "best analyst" by vibes. Build an **eval harness** (`scripts/eval-desk.ts`):
- **Backtest on known outcomes:** run the desk on historical prints where the subsequent quarter/return is known; score directional calls and **confidence calibration** (does 0.7 confidence mean right 70% of the time?).
- **A named failure metric: "true-data rejection rate"** — how often the desk flags real, sourced figures as errors. This exact failure would have been caught pre-Micron.
- **Groundedness metric:** % of load-bearing claims with a citation. Today's MU report scores ~15% (2/13). Target >90%.
- Feed these back into config (`config/desk.ts`) and prompts. Measured loops, not intuition.

---

## 9. Sequencing (build order by root-cause leverage)

| Phase | Ships | Why first |
|-------|-------|-----------|
| **P1 — Grounding** | Retrieval Planner + expanded sources (transcripts, history, pricing) + Grounded Fact Store + "no claim without citation" | Root cause R1/R3. Everything downstream inherits its quality from here. Without it, better reasoning just produces more confident ungrounded prose. |
| **P2 — Surprise loop** | Anomaly Investigator + deepen re-orientation | Root cause R2. Cheap, high-safety, prevents the worst failure. |
| **P3 — Adjudication** | Rebuilt head-of-research (fact-dispute resolution + owned judgment splits + load-bearing gate) | Root cause R3. Depends on P1's fact store. |
| **P4 — Model spine** | Grounded driver-tree model; scenarios/MC as outputs | Root cause R4. Depends on P1's history/data. |
| **P5 — Decision engine** | Positioning stage + mandatory variant view | Root cause R5. The stage that makes reports *decide*. |
| **P6 — Eval** | Calibration + true-data-rejection + groundedness metrics | Turns the above into a measurable flywheel. |

**Guiding line:** we are not making the debate smarter. We are **feeding it real evidence, forcing it to explain surprises, making it rule instead of average, grounding its numbers, and making it commit to a call** — then measuring whether the calls are right.

---

*End Document 1. Companion: Document 2 — the report as an institutional positioning document.*
