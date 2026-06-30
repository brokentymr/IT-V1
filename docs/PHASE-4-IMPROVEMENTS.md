# Phase 4 — Fundamental Research: improvement backlog

Captured 2026-06-30 (owner). These build on the shipped Engine 2 (see `PHASE-4.md`). None are
blockers; they deepen the engine from "extract + narrate the filing" toward "model the forward
distribution of outcomes." Ordered roughly by dependency. Each notes where it slots into the
existing code and what it needs from the owner.

---

> **Status update 2026-06-30 (final):** #1, #2, #3, #4 are all **delivered**.
> - #1/#2 via the Perplexity/Fiscal.ai integration (consensus, estimates, beats/misses,
>   Morningstar-style fair-value/moat). Dedicated **transcripts** remain deferred (no source yet).
> - #3 **MD&A driver extraction** + #4 **Monte Carlo scenario** shipped: the coverage pass reads the
>   MD&A, extracts bear/base/bull drivers, and runs a pure-TS Monte Carlo (hybrid bounds, beat-prob
>   vs Perplexity consensus, sensitivity-ranked watch-items). See `PHASE-4.md` and the modules
>   `lib/financials/montecarlo.ts`, `lib/financials/filing_text.ts`.
>
> Only remaining Phase-4 item: **earnings-call transcripts** when a source is provided.

## 1. Premium data sources (fundamentals + transcripts) — ✅ mostly done via Perplexity/Fiscal.ai
**Why:** today the engine is XBRL-only (free EDGAR). XBRL gives clean structured numbers but lags
minutes-to-hours, omits guidance/consensus, and has no earnings-call transcript. Premium sources
fill exactly the gaps the spec's §1.3 table earmarked for Engine 2.

**What each unlocks**
- **FMP / Fiscal.ai** — normalized statements + ratios + **forward estimates/consensus** (gives the
  forward pass a real "what the market expects" baseline instead of an LLM guess) and a faster
  filing feed than polling.
- **S&P Global / Morningstar** — analyst fair-value, credit, and segment data for richer thesis
  context and cross-checks against our deterministic model.
- **Transcripts** (provider TBD) — the deferred half of §4.2; the coverage pass currently skips the
  call. Management tone + Q&A is where guidance and risk language actually live.

**How it slots in:** each is just another adapter behind the existing `SourceResult<T>` interface
(`lib/sources/types.ts`) — same shape as `sec.ts`/`news.ts`, injectable for tests, degrades on
failure. The deterministic model (`lib/financials/model.ts`) stays the source of truth; premium
feeds become *additional* provenance-stamped inputs, not replacements.

**Owner action:** these can't be self-provisioned (ToS/payment/email verify). Per the established
model, owner pastes a key or authorizes a free-tier signup **per source, per need**. Cost ceiling +
Haiku-testing discipline still applies.

---

## 2. Perplexity Financial API integration
**Why:** a keyed, real-time synthesis layer that's strong exactly where keyless sources are weak —
**forward earnings dates** (replacing the flaky Nasdaq scrape → cadence fallback), live consensus,
and quick qualitative context ("what changed since last quarter, in plain language").

**Where it goes**
- **Earnings-date resolver** (`lib/sources/earnings.ts`): add a `PerplexityEarningsAdapter` as the
  new primary in `resolveNextEarningsDate`, ahead of Nasdaq/cadence. Same precedence machinery,
  one more tier.
- **Forward pass context** (`runForwardPass`): feed Perplexity's consensus/expectations summary into
  `frameForward` so "what the market expects" is sourced, not invented.
- Keep it **advisory, never in the number path** — Perplexity informs framing and dates; the XBRL
  model stays deterministic and provenance-stamped (owner decision 2026-06-30 holds).

**Owner action:** Perplexity API key (paste per the §1.3 model). Add a `lib/llm`-style cost stamp so
its spend lands in the same `llm_usage` ledger and respects `MONTHLY_SPEND_CEILING_USD`.

---

## 3. Extended hypothesis from MD&A text (range of potential impacts)
**Why:** today the coverage pass reads only a **bounded concentration excerpt** for link enrichment
and otherwise narrates the numbers. The richest forward signal — management's own stated drivers,
risks, and guidance — lives in the **MD&A** (10-K Item 7 / 10-Q Item 2) and the risk factors. We're
leaving it on the table.

**What to build**
- A **MD&A extractor**: pull Item 7/Item 2 from the primary document (we already fetch it in
  `enrichLinksFromFiling`), section-segment it, and have the analyst extract a structured list of
  **drivers** — each with: direction, management's framing, and a **plausible impact range**
  (bear / base / bull) on the metrics the model tracks (revenue, gross margin, etc.).
- Persist as a new `current_events.hypotheses[]` block (additive to the §3 contract, like
  `forward_note` was) so it carries into the next forward pass and into content.
- Each driver's range is **grounded** (quote + filing ref) and feeds directly into #4.

**Effort:** medium. Reuses the filing-doc fetch + the injectable analyst pattern; main new work is
robust section segmentation of messy filing HTML and a tighter extraction schema.

---

## 4. Monte Carlo of potential outcomes + "what to watch next"
**Why:** the natural payoff of #3. Instead of a single point thesis, model the **distribution** of
next-period outcomes and surface which leading indicators move it most — turning the forward pass
from a narrative into a probabilistic, watchlist-generating view.

**Sketch (all deterministic TS — no LLM in the math, consistent with the locked decision)**
- **Inputs:** per-driver impact ranges from #3 (bear/base/bull → a triangular/PERT distribution) +
  **historical variance** of each metric from the XBRL series we already pull (`companyFacts` gives
  many periods, not just the latest).
- **Engine:** sample N runs (e.g. 10k) over the driver assumptions → distributions for next-period
  revenue, margin, EPS. Output P10/P50/P90 bands, probability of beating the forward expectation,
  and a **sensitivity ranking** (which driver explains the most outcome variance).
- **"What to look out for next":** the top sensitivity drivers become concrete, measurable
  **watch-items** — exactly the form our invalidation triggers already take, so they flow straight
  into the thesis and the daily monitor's `rolling_outlook`.
- **Storage:** a `scenario` sub-block on the snapshot (`content.fundamentals.scenario`), provenance
  back to the MD&A drivers and the historical series.

**Effort:** medium-high, and best gated behind #3 (needs the driver ranges) and ideally #1/#2 (a
real consensus baseline makes "probability of beating expectations" meaningful rather than relative
to an LLM guess). Pure-TS Monte Carlo keeps it cheap, reproducible, and testable.

---

## Suggested sequence
1 (data keys) and 3 (MD&A extraction) are the unlocks; 2 firms up dates/consensus; 4 is the
capstone that ties driver ranges + historical variance into a probabilistic forward view. A sane
order: **3 → 1/2 (as keys arrive) → 4**, each demoed under the cost ceiling like every phase.
