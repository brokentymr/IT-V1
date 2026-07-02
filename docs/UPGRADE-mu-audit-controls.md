# Research Pipeline Improvement Document
## Case Study: MU Q3 FY2026 Report Audit → Generalized Pipeline Controls

**Scope:** This document converts a manual audit of the Micron (MU) Q3 FY2026 desk report (approved 2026-07-02, snapshot 10-Q Q3 2026) into two artifacts: (1) specific defects in that report, each traced to the exact assertion and the verified ground truth, and (2) the abstracted problem→solution pattern each defect represents, so the fix generalizes across every asset the pipeline covers. Each finding carries an ID; each pattern references the findings that motivated it. The intent is that every defect becomes a permanent control, not a one-off correction.

**Severity scale:** `S0` = fabricated or materially wrong data driving conclusions · `S1` = wrong/missing data not yet driving conclusions · `S2` = statistical or logical rigor gap · `S3` = editorial/rendering quality.

---

## ⚠️ Implementation Directive — Read Before Acting

**All remediation is architectural. No finding in this document is to be fixed by hand-editing the MU report.**

1. **Fix the pipeline, not the artifact.** Every defect below is treated as evidence of a missing or broken pipeline control. The remediation for each finding is the corresponding Part II pattern (P1–P13) implemented in extraction, validation, synthesis, or rendering — never a manual correction, prompt patch scoped to Micron, or one-off override. If a fix only works for MU, it is not a fix.
2. **The MU findings are the testing anchors.** After the architectural changes land, **re-run the MU Q3 FY2026 report end-to-end from source** through the modified pipeline. The regenerated report is the acceptance test. Each finding (F1–F12) defines a pass/fail condition — see the **Re-run Acceptance Checklist** at the end of this document. The "Fix" line under each finding describes the *expected characteristics of the regenerated output*, not an edit instruction.
3. **Pass = the pipeline caught it, not just that the number changed.** For the S0 findings especially, acceptance requires evidence that the *control* fired (identity-gate log, provenance quarantine, blocked trigger) — a correct number that happens to be extracted correctly on the re-run, with the gate untested, is a non-pass.
4. **Anchors carry forward.** Once passed, the MU anchors become permanent regression fixtures (per P13). Every future asset report runs against the same control suite; every future audit adds new anchors to it.

---

## Part I — Specific Findings in the MU Report
### (Testing Anchors: each finding = a pass/fail condition for the pipeline re-run)

### F1 · Operating cash flow is wrong by ~80%, and the error is load-bearing — `S0`

- **Where:** Fundamentals table ("Operating cash flow $45.7B, 287.5%"); risk card ("operating cash flow exceeding revenue ($45.7B OCF vs. $41.5B revenue)... warrant forensic scrutiny for timing of customer deposits being classified as operating inflows"); thesis rationale ("we attribute the OCF>revenue print substantially to $18B SCA cash deposits classified as operating inflows... FCF durability should be discounted").
- **Assertion:** OCF of $45.7B, exceeding revenue — treated as an accounting anomaly requiring forensic explanation.
- **Ground truth:** Micron's reported FQ3 2026 operating cash flow was **$25.39B**. OCF does **not** exceed revenue ($41.5B). There is no anomaly to explain.
- **Why it's the worst defect in the report:** The pipeline extracted a wrong number, *detected* that the wrong number was anomalous (OCF > revenue), and then **synthesized a plausible fabricated explanation** ($18B SCA deposits reclassified as operating inflows) to resolve the anomaly it created. That explanation then propagated into the thesis ("discount FCF durability"), the risk register ("forensic scrutiny"), the invalidation triggers ("contract liabilities/customer deposits fall materially below the ~$18B disclosed level"), and the confidence framing. One extraction error became a four-surface fabricated narrative.
- **Expected on re-run (anchor F1):** OCF extracts as $25.39B; the identity gate logs a pass (or, if extraction errs again, a hard-stop); no OCF>revenue forensic thread appears anywhere; FCF-durability judgment derives from correct figures; no trigger references an "$18B disclosed level" (see F3). Controls: P1, P2, P4.

### F2 · Free cash flow figure doesn't tie — `S0`

- **Where:** Thesis ("$26.1B FCF"), sentiment-gap card ("FCF $26.1B"), repeated across cards.
- **Assertion:** Quarterly FCF of $26.1B.
- **Ground truth:** Micron reported **adjusted free cash flow of $18.3B** for FQ3. $26.1B matches no reported figure and is internally inconsistent with the report's own numbers under any FCF definition (correct OCF $25.39B − capex $19.6B ≈ $5.8B unadjusted; the company's adjusted figure is $18.3B, net of government incentives and partner contributions).
- **Fix:** Replace with $18.3B, labeled "adjusted FCF (company definition)," and show the OCF − capex bridge so the definition is auditable.

### F3 · "$18B SCA cash deposits" appears to be a fabricated disclosure — `S0`

- **Where:** Thesis ("$18B in cash deposits"), rationale ("$18B SCA cash deposits classified as operating inflows — legitimate but non-recurring"), invalidation trigger ("customer deposits fall materially below the ~$18B disclosed level").
- **Assertion:** The company disclosed ~$18B of SCA customer cash deposits, and these flowed through operating cash.
- **Ground truth:** No such $18B deposit disclosure is verifiable in the filing or earnings materials. The suspicious coincidence: **$18.3B is the actual adjusted FCF figure.** The most likely failure mechanism is that the model encountered $18.3B in the source, mislabeled it as "SCA cash deposits," and used it to explain the (also wrong) OCF anomaly. A real number was relabeled into a nonexistent disclosure.
- **Fix:** Remove the deposit claim entirely unless it can be pinned to a specific filing passage. The invalidation trigger built on it must be retracted — a monitoring trigger keyed to a nonexistent disclosure can never fire and silently degrades the whole trigger framework.

### F4 · SCA coverage overstated; the strongest verifiable disclosure ($100B RPO) is missing — `S1`

- **Where:** Thesis ("16 take-or-pay SCAs covering up to ~50% of future revenue"), sector card ("covering up to 50% of future revenue through 2027+"), technology card ("covering ~50% of future revenue").
- **Assertion:** SCAs cover ~50% of future revenue.
- **Ground truth:** The company disclosed 16 SCAs covering **~20% of DRAM and up to a third of NAND volume**, and — the headline datum — **remaining performance obligations of approximately $100B** across executed SCAs. The prepared remarks explicitly frame RPO as based on minimum committed volumes and minimum pricing.
- **Why it matters:** The pipeline simultaneously *overstated* the revenue-visibility claim (~50% vs ~20% DRAM) and *omitted* the single most powerful, citable number supporting the bull case ($100B RPO). The report is arguing the durability debate with a weaker, wrong version of the bull evidence. For a platform whose product is credibility, missing the headline disclosure of the quarter is a coverage failure, not just an accuracy one.
- **Fix:** Restate coverage as disclosed (20% DRAM / up to ⅓ NAND); add the $100B RPO with the company's own conservatism caveat; rerun the thesis paragraph, which currently reasons from the wrong coverage figure.

### F5 · Monte Carlo "What to watch next" renders one template for all drivers — `S2`

- **Where:** Next-period scenario card. All three drivers end in the identical clause "pulls revenue toward $17.34B (P10)":
  - "AI-driven HBM demand (59% of variance): **bear case +5pts to revenue growth** pulls revenue toward $17.34B (P10)" — a *positive* shock described as pulling revenue to the *downside* tail.
  - "HBM mix shift driving higher ASPs (5% of variance): bear case **+1pts to gross margin** pulls **revenue** toward $17.34B (P10)" — a *margin* driver rendered against a *revenue* percentile.
- **Assertion(s):** Each driver's bear case maps to the P10 revenue outcome.
- **Ground truth:** Internally contradictory — a +5pt growth shock cannot produce the P10 revenue tail; a gross-margin driver's target metric is not revenue. The variance decomposition (59/28/5) is likely fine; the natural-language rendering ignores sign and metric.
- **Fix:** The renderer must consume `(driver, direction, affected_metric, percentile)` as typed fields, assert `direction`/`percentile` consistency (bear ⇒ P10-side *of that metric*, bull ⇒ P90-side), and route margin drivers to margin/EPS percentiles. A unit test with one bull and one bear driver catches this class permanently.

### F6 · Sentiment trend claims exceed what n=8–30 supports — `S2`

- **Where:** Sentiment card, conf 70%: Stocktwits VOL 30, NET **+0.78**, trend "falling"; news VOL 8, NET **+0.13**, trend "rising"; narrative "Momentum is fading fast."
- **Assertion:** Directional trend and two-decimal net sentiment, characterized as fast-moving crowd psychology.
- **Ground truth problem:** With n=8, a single flipped item moves NET by ±0.25 — twice the reported signal. "Rising"/"falling" on these samples is indistinguishable from noise, and "fading fast" is a narrative built on it. The card already carries a degradation flag ("Degraded: 1 source(s)"), which is the right instinct applied inconsistently.
- **Fix:** Volume floor (e.g., n≥50) below which trend is suppressed and NET is shown as a range or "insufficient volume"; precision capped to one decimal below n=100; narrative generator prohibited from tempo language ("fast," "rapidly deflating") when all underlying platforms are below floor.

### F7 · Ticker/entity disambiguation detected but not enforced — `S3`

- **Where:** Current events: "Replay: Richmond Flying **Mu** vs Rivets" (minor-league baseball), "'**Mu Yi** and the Handsome General' Director..." (animated film), "**MU** School of Medicine Department of Psychiatry..." (University of Missouri) — all tagged `other`, engagement 0–2, listed beside one genuine MU-relevant item.
- **Problem:** The classifier correctly binned these as `other`, then the UI surfaced them anyway. Detection without a gate reads as sloppiness and, worse, `other`-class items could someday leak into sentiment or event scoring.
- **Fix:** `other`-classified, sub-threshold-engagement items are excluded from the rendered feed by default (collapsible "N filtered" affordance if transparency is wanted) and hard-excluded from any scoring input. For short/collision-prone tickers (MU, GM, F, A, ALL...), require a second entity signal (company name, exchange, sector term) before an item is even classified.

### F8 · The same seven statistics restate across six cards — `S3`

- **Where:** 84.6% GM, 68.1% net margin vs 20.1% avg vs −62.6% trough, Morningstar $455, ~$1,009 consensus, ~$1,150 spot, 16 SCAs, $27B→mid-$40s capex — each appears near-verbatim in the thesis, sector card, technology card, risk card, sentiment card, and multiple resolved-event rationales.
- **Problem:** Redundancy is the single strongest "generated, not written" tell. A human desk states a fact once and *builds* on it. Repetition also inflates apparent evidence: the same datum re-encountered six times feels like six data points.
- **Fix:** Maintain a per-report **fact registry** (statistic → canonical statement → citation). First use renders in full; subsequent modules must either reference it or contribute a *new* analytical angle on it. A post-synthesis dedup pass that flags any numeric string appearing >2 times forces each card to justify its marginal information.

### F9 · Risk sections render as semicolon walls while triggers render as structure — `S3`

- **Where:** Risk blocks on the sector/technology/risk cards are single paragraphs chaining 5–7 distinct risks with semicolons and inline ALL-CAPS headers ("CAPEX TRAP / DEPRECIATION OVERHANG: ...; EXPORT CONTROL / GEOPOLITICAL ESCALATION: ...").
- **Contrast:** The invalidation-triggers section on the same page already renders discrete, titled, individually scannable items — proving the correct pattern exists in the system.
- **Fix:** Risks become typed objects `(title, mechanism, quantified impact, probability/severity tag, linked invalidation trigger)`, rendered as the triggers are. This also enables the missing linkage: every named risk should map to at least one trigger, and every trigger to a risk — F3's orphaned trigger would have been caught by exactly this join.

### F10 · P(beat EPS) = 25.6% contradicts the observed regime with no stated reason — `S2`

- **Where:** Monte Carlo card: "P(beat rev consensus) 49.7%," "P(beat EPS) 25.6%."
- **Tension:** The company has beaten for five consecutive record quarters (Q3 EPS beat consensus by ~21%) and guided Q4 *above* the consensus the simulation is scored against. A 1-in-4 beat probability implies the model's distribution is centered below a consensus that management's own guidance exceeds — i.e., a strong mean-reversion prior silently overriding observed momentum. That may even be the house view, but stated as a bare number it looks like a bug.
- **Fix:** Whenever simulated P(beat) diverges from the trailing empirical beat rate by more than a threshold (say 30pts), auto-generate one sentence naming the driver ("distribution assumes ASP normalization begins in FQ4, versus guidance which assumes continued price increases"). Model-vs-evidence tension is fine; *unexplained* tension is not.

### F11 · Margin labeling: 84.6% vs 84.9% — `S1` (verify)

- **Where:** "84.6% gross margin" throughout; press coverage and the company deck headline **84.9%** (non-GAAP).
- **Likely benign:** 84.6% may be the GAAP figure vs 84.9% non-GAAP. But the report never says which basis it's on, and the thesis hinges on margin durability, so basis ambiguity is not cosmetic here.
- **Fix:** Every margin/EPS figure carries a GAAP/non-GAAP tag; where the two diverge, show both once. (Same discipline resolves the report's $24.67 GAAP vs $25.11 non-GAAP EPS usage, which currently mixes without labels.)

### F12 · The report stages the debate but never resolves into a position — `S2`

- **Where:** Global. The doc establishes spot ~$1,150, consensus ~$1,009, Morningstar $455, conviction 3/5, "our lean: SCAs shorten and cushion the next downcycle but do not repeal the cycle... treat current margins as peak, not..." — and stops.
- **Problem:** For a *positioning* document feeding a content franchise, "conviction 3/5" with a wide unresolved fair-value spread is an analysis, not a position. The reader is never told: what margin-durability assumption is embedded in $1,150; at what price the house lean implies the risk/reward flips; what size/entry/exit discipline follows from the triggers already written.
- **Fix:** Add a mandatory **Positioning** module: (a) reverse-DCF or implied-assumptions statement ("spot price requires ~X quarters of >80% GM"), (b) house fair-value range consistent with the stated lean, (c) action framing keyed to the invalidation triggers (each trigger = a pre-committed de-risk/exit rule). Also populate **Relationships** — NVIDIA socket dependency, SK Hynix HBM share, the GM agreement, hyperscaler capex — which is currently empty despite the risk text referencing all of them; that read-through graph is where much of the multi-asset content value lives.

---

## Part II — Abstracted Problem→Solution Patterns (carry-over to all assets)

### P1 · Deterministic accounting-identity gate before synthesis
**Motivated by F1, F2.** LLM extraction will produce wrong financials at some rate forever; the defense is arithmetic, not better prompting. Before any narrative synthesis runs, a non-LLM validator asserts, per snapshot: assets = liabilities + equity (±rounding); OCF ≤ revenue unless an explicit exception flag with citation; FCF = OCF − capex (or labeled "adjusted" with a bridge); margins = ratios of extracted line items; YoY %s recompute from prior-period stored values. **Any failure hard-stops synthesis** and routes to re-extraction or human review. This single control catches F1 and F2 automatically, for every asset, on day one. Highest ROI item in this document.

### P2 · Anomaly claims require a citation, or they are extraction-error hypotheses
**Motivated by F1.** The most dangerous pipeline behavior observed: detecting an anomaly *it created* and then generating a fluent explanation for it. Rule: when the system detects a statistical anomaly (OCF > revenue, margin outside historical range, receivables spike), the **first hypothesis is always extraction error**, checked against P1 and a second source, before any explanatory narrative is permitted. Explanations of anomalies must cite the specific filing passage that supports the explanation — "SCA deposits classified as operating inflows" is only writable if the cash-flow-statement or footnote text saying so is attached.

### P3 · Every numeric claim carries provenance; unverifiable numbers are quarantined, not narrated
**Motivated by F2, F3.** The "$18B SCA deposits" defect is a real number ($18.3B FCF) relabeled into a fictitious disclosure. Enforce a claim schema: `(value, unit, period, source_doc, source_locator, extraction_confidence)`. Numbers lacking a locator render with an explicit `[unverified]` badge and are barred from theses, triggers, and risk registers. Cash-flow-statement items specifically should be tiered to the filing itself (the P&L extraction was accurate while cash flow was not — evidence the CFS is being pulled from a weaker source path; audit and pin that path).

### P4 · Dependency-tracked claims: when an input dies, its descendants die
**Motivated by F1→F3 propagation.** One wrong OCF figure contaminated the thesis, a risk card, an invalidation trigger, and the confidence framing. Represent synthesized claims as a DAG: each thesis sentence, risk, and trigger records which atomic facts it consumes. When a fact is corrected or retracted, every downstream claim is flagged stale and must re-synthesize — no silent survivals. This also gives you the audit trail that makes "Veto & retract" meaningful at the claim level rather than the document level.

### P5 · Per-filing-type disclosure checklist ("did we capture the headline?")
**Motivated by F4.** The pipeline missed $100B RPO — the quarter's most citable disclosure — while inventing a weaker proxy. Maintain a checklist per event type: earnings ⇒ {revenue, GM (GAAP+non-GAAP), EPS both bases, OCF, capex, FCF+definition, guidance, RPO/backlog if disclosed, buyback/dividend actions, customer-concentration updates}. A coverage scorer diffs the checklist against extracted claims and flags gaps before approval. Separately: coverage/percentage claims ("~50% of future revenue") must quote the company's own phrasing or be tagged as an estimate — the drift from "20% of DRAM" to "50% of revenue" is a paraphrase-inflation failure the tag would surface.

### P6 · Typed rendering with invariant checks, not string templates
**Motivated by F5.** Scenario text must be generated from structured `(driver, direction, affected_metric, percentile_target)` with asserted invariants (bull ⇒ upside percentile; metric in text = metric in field). Add golden-file unit tests: one bull driver, one bear driver, one margin driver — render, assert. This pattern generalizes to every generated sentence that embeds model output: the renderer is code, code gets tests.

### P7 · Statistical floors gate every quantitative-sounding claim
**Motivated by F6, F10.** Trend direction, two-decimal scores, and tempo language ("fading fast") are only emitted above minimum-n thresholds; below them, render ranges or "insufficient volume." And whenever a model probability contradicts observable base rates (P(beat)=25.6% vs a 100% trailing beat streak with above-consensus guidance), require one auto-generated sentence naming the assumption that drives the divergence. Precision and confidence must be earned by sample size or explained by assumption — never free.

### P8 · Entity resolution is a hard gate, especially for collision-prone tickers
**Motivated by F7.** Classification already works; enforcement doesn't. `other`-class items are excluded from display defaults and from *all* scoring inputs. Short tickers require ≥2 entity signals to classify at all. Keep a per-ticker collision list (MU: Missouri, Flying Mu, Mu Yi...) that grows from filtered items — the filter improves itself.

### P9 · Fact registry + dedup pass: each module must add marginal information
**Motivated by F8.** Canonical fact stated once with citation; downstream modules reference or extend, never restate. Post-synthesis linter flags any numeric string >2 occurrences. The perceived-quality gain here exceeds most feature work: it is the difference between "a desk wrote this" and "a model padded this."

### P10 · Risks and triggers are one typed, joined system
**Motivated by F9, F3.** Risks: `(title, mechanism, quantified impact, tag, linked_trigger_id)`. Bidirectional completeness check: risk without trigger ⇒ warn; trigger without risk or without a verifiable underlying disclosure ⇒ block (this join alone would have caught the fabricated $18B trigger). Render both with the discrete-item pattern the triggers already use.

### P11 · Basis labeling is mandatory (GAAP/non-GAAP, adjusted/unadjusted)
**Motivated by F2, F11.** Every margin, EPS, and cash-flow figure carries its basis tag; divergent bases shown side-by-side once. Definitional ambiguity in a durability thesis is a substantive error, not a style issue.

### P12 · A positioning doc must terminate in a position
**Motivated by F12.** Mandatory final module per asset: implied-assumptions readout at spot, house fair-value range consistent with the stated lean, and trigger-keyed action rules. Conviction scores without price-conditional consequences are commentary. Populate the relationship graph as a first-class output — cross-asset read-throughs are the compounding advantage of running this pipeline over a whole universe rather than one name.

### P13 · Every caught defect becomes a regression test
**Meta-pattern.** This audit found ~12 defects; the durable value is not fixing them in the MU report but encoding each as an automated check: F1/F2 → identity-gate test vectors; F3 → provenance-required trigger test; F5 → renderer golden files; F6 → volume-floor tests; F7 → MU collision fixtures; F8 → dedup linter fixture. Institutionalize the loop: human audit → defect ID → control → test → the same defect class can never ship again, on any asset.

---

## Prioritized Roadmap

| Priority | Item | Patterns | Effort | Rationale |
|---|---|---|---|---|
| **P0** | Accounting-identity gate (hard-stop) | P1 | Low — deterministic checks | Catches the S0 class automatically; protects credibility |
| **P0** | Provenance schema + unverified-number quarantine | P3 | Medium | Kills fabricated-disclosure class (F3) |
| **P0** | Veto & retract the current approved MU report; re-run end-to-end through the corrected pipeline; validate against the acceptance checklist below | P1–P4, P13 | Low (given P0 controls) | An approved report with S0 errors is live reputational risk; the re-run is the acceptance test — do **not** hand-edit |
| **P1** | Anomaly ⇒ extraction-error-first protocol | P2 | Low | Prevents fluent explanations of self-created anomalies |
| **P1** | Claim dependency DAG + stale-propagation | P4 | Medium-High | Makes corrections and vetoes claim-level, auditable |
| **P1** | Disclosure checklist / coverage scorer per filing type | P5 | Medium | Stops headline-miss failures (RPO class) |
| **P1** | Typed scenario renderer + golden tests | P6 | Low | Fixes visible template bug class |
| **P1** | Dedup linter + fact registry | P9 | Medium | Largest perceived-quality gain per unit effort |
| **P2** | Sentiment volume floors + tempo-language gate | P7 | Low | Rigor hygiene |
| **P2** | Entity-gate enforcement + collision lists | P8 | Low | Feed hygiene; protects scoring inputs |
| **P2** | Risk/trigger typed join + structured render | P10 | Medium | Consistency + catches orphaned triggers |
| **P2** | Basis labeling (GAAP/non-GAAP) | P11 | Low | Definitional hygiene |
| **P2** | Positioning module + relationships graph | P12 | Medium-High | Product depth; the content-franchise payoff |
| **Continuous** | Defect → regression test loop | P13 | Process | Compounds every audit into permanent controls |

---

## Re-run Acceptance Checklist (MU Q3 FY2026 anchors)

Run the MU report end-to-end from source through the modified pipeline. Grade each anchor. **All S0/S1 anchors must pass before the report is re-approved; the report ships only via the normal approval flow, never as an edited artifact.** Where noted, "control evidence" means a log/audit entry showing the gate executed — not merely a correct-looking output.

| Anchor | Pass condition on regenerated report | Control evidence required |
|---|---|---|
| **F1** | OCF = $25.39B; no OCF>revenue claim or forensic-scrutiny narrative anywhere in thesis, risks, or triggers | Identity-gate execution log for the snapshot (P1) |
| **F2** | FCF = $18.3B labeled "adjusted (company definition)" with OCF−capex bridge rendered | Basis tag present (P11); identity check log (P1) |
| **F3** | No "$18B SCA deposits" claim; no invalidation trigger keyed to it; every trigger cites a verifiable disclosure | Provenance locator attached to every trigger; quarantine log if any unverifiable number was caught (P3, P10) |
| **F4** | SCA coverage stated as ~20% DRAM / up to ⅓ NAND; $100B RPO present with the company's conservatism caveat | Disclosure-checklist coverage score showing RPO captured (P5) |
| **F5** | Each Monte Carlo driver's text matches its direction and affected metric; bull drivers do not point at P10 revenue | Renderer golden tests passing (P6) |
| **F6** | No trend arrow or tempo language on platforms below volume floor; NET precision capped per floor rules | Floor-gate config + suppression log (P7) |
| **F7** | Zero `other`-class items in the rendered Current events feed; none present in any scoring input | Entity-gate filter log with collision list hits (P8) |
| **F8** | No numeric fact string appears >2× across the report; each module adds marginal information | Dedup-linter report attached (P9) |
| **F9** | Risks render as discrete typed items; every risk links a trigger and every trigger links a risk | Risk↔trigger join check passing (P10) |
| **F10** | If P(beat) diverges >30pts from the trailing empirical beat rate, an assumption sentence is present naming the driver | Divergence check log (P7) |
| **F11** | Every margin/EPS/cash-flow figure carries a GAAP/non-GAAP or adjusted/unadjusted tag | Basis-tag linter passing (P11) |
| **F12** | Positioning module present (implied-assumptions readout, house FV range, trigger-keyed actions); Relationships populated | Module presence check (P12) |
| **Meta** | All twelve anchors registered as permanent regression fixtures executed on every future report build | CI suite listing (P13) |

**Failure protocol:** any failed anchor is a pipeline defect, not a report defect — return to the corresponding Part II pattern, strengthen the control, and re-run. Iterate until green. Do not converge by editing output.

---

*Prepared 2026-07-02 from audit of the MU Q3 FY2026 desk report (markets.kuramoto.io) against Micron's reported FQ3 2026 results and earnings materials. Financial figures cited for verification: revenue $41.46B; GAAP net income $28.24B / EPS $24.67; non-GAAP EPS $25.11; GM 84.9% non-GAAP; OCF $25.39B; adjusted FCF $18.3B; capex ~$27B FY26; 16 SCAs, ~20% DRAM / up to ⅓ NAND coverage; RPO ~$100B; FQ4 guide $50B ±$1B, ~86% GM, $31 ±$1 EPS.*
