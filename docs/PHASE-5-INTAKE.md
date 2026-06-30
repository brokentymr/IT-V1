# Phase 5 follow-up — agentic natural-language asset intake (record)

**Status:** ✅ complete — built, tested (67/67), live on https://markets.kuramoto.io (2026-06-30).

## What changed
The Universe's "add" front door is now natural-language + agentic instead of ticker-only. The
operator types intent — a company, several names, or a sector/theme to drill into — and Perplexity
(web-grounded) resolves it to concrete entities with tickers + listing status, plus any research
focus the operator named.

## Owner decisions (2026-06-30)
- **Propose → select → add** (a confirm step before anything is created).
- **Auto-run on add** (listed → coverage; private → profile pass).
- **Record + Perplexity profile** for private / pre-IPO names.
- **Pre-IPO S-1 filers are NOT profile-only** — they have SEC filings, so resolve name → CIK via
  EDGAR and run the real coverage pass on the S-1.
- **Research focus = a WEIGHT, not a filter** — an extra-emphasis topic layered on top of the full
  analysis; it must never cost breadth.

## Flow
1. **Resolve** (`lib/engines/intake.ts → resolveEntities`, `/api/intake/resolve`): NL → Perplexity →
   `{ entities: [{name, ticker|null, listing, exchange, sector, rationale}], research_focus: [string] }`.
   Sector/theme inputs expand to the notable constituents (capped).
2. **Review** (`app/universe/AddAsset.tsx`, client): the agent's proposal renders with checkboxes +
   an editable research-focus field; the operator picks what to add.
3. **Add** (`/api/intake/add → addResolvedEntity`):
   - **listed** → `ingestCompany(ticker)` (SEC EDGAR) → enqueue coverage.
   - **pre_ipo** → `SecAdapter.searchByName` (EDGAR full-text S-1 search) → `ingestByCik` → enqueue
     coverage on the S-1. If no S-1 filer is found → profile fallback.
   - **private** → `createUnlistedCompany` (tickerless record) → enqueue `PROFILE_PASS`.
   - the request's `research_focus` is stored on each company (`coverage.research_focus`).

## New / changed pieces
- **Resolver + add paths** (`lib/engines/intake.ts`), **private profile engine**
  (`lib/engines/private_profile.ts`, Perplexity → a `Profile` snapshot the Company screen renders),
  **PROFILE_PASS** job + worker handler (`lib/jobs/profile.ts`).
- **Ingestion refactored** (`lib/engines/ingestion.ts`): shared `persistIdentity`; idempotency moved
  to CIK (so tickerless pre-IPO records dedupe); new `ingestByCik`.
- **EDGAR name search** (`SecAdapter.searchByName`, efts.sec.gov full-text).
- **Migration 0010**: `companies.listing` (listed | pre_ipo | private).
- **Research-focus threading**: `coverage.research_focus` flows into `draftThesis` + `extractDrivers`
  + the private profile prompt, worded as **added emphasis that preserves full breadth**.
- **UI**: Universe add panel (the NL flow + listing tags); Company screen renders a **Profile** panel
  for private names, a research-focus line, and a "Build / refresh profile" action for unlisted names.
- **Console password** changed to `demo` (Caddyfile bcrypt hash; demo only).

## Testing milestone — 67/67 passing
`tests/intake.integration.test.ts`: resolve → entities + focus; listed add via SEC ingest (focus
stored); **pre-IPO S-1 filer ingested by CIK** (tickerless, listing pre_ipo, focus stored); private
add → tickerless record + enqueued profile pass (idempotent by name); profile pass → a `Profile`
snapshot with thesis. Ingestion tests still green after the CIK-idempotency refactor.

## Live verification
- Resolve *"Nvidia and its two biggest competitors, focused on AI datacenter demand and pricing
  power"* → NVDA, AMD, AVGO (listed) + focus `["AI datacenter demand","pricing power"]`.
- A focus-weighted AAPL coverage kept full breadth (6 drivers, 11 metrics, scenario) while the
  thesis + invalidation triggers explicitly addressed price increases / demand destruction.

## Open items
- Sector expansion cap is fixed; a "show more / refine" affordance could come later.
- Private-company **deep** analytics (funding rounds, cap table, valuation marks) remain a future
  engine; today private names get a qualitative Perplexity profile + news monitoring.
