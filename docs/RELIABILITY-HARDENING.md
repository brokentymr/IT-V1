# Reliability hardening — verified resolution + the analyst desk (record)

**Status:** ✅ complete — built, tested (68/68), live (2026-06-30).

## Why
The intake resolver mislabeled **Cerebras (public, CBRS) as private** — a class of failure where the
system trusted a single LLM's word on a verifiable fact, with no second opinion and no skeptic. The
owner's bar: "absolutely tight, tier-one bank analyst level." This hardens the agentic loops to that
standard before further phase work.

## Owner decisions (2026-06-30)
- **Model tiering + a sane ceiling:** Opus for synthesis + adversarial verification, Sonnet for the
  expert lenses, Haiku for mechanical. `LLM_MODEL_OVERRIDE` removed from `.env`; ceiling kept at $50
  (a safety cap; a full tiered coverage pass ≈ $0.35–0.40, so ~70–100 runs/mo).
- **The desk:** four lenses — equity/fundamentals, sector/competitive, technology/moat, risk/bear.
- **Execution:** build the whole pipeline, then demo.

## 1. Ground-truth verified resolution (the LLM proposes, the system decides)
No verifiable fact rides on an LLM guess. After Perplexity proposes entities, each is verified against
SEC EDGAR (`lib/engines/intake.ts → verifyEntity`):
1. a given ticker → confirm in the SEC ticker index;
2. else the name in the ticker index → **listed** (real ticker/CIK) — *this catches Cerebras*;
3. else an S-1 filer (EDGAR full-text) → **pre_ipo** (CIK);
4. else → unverified (kept as the LLM said, but flagged; preserves foreign listings honestly).
New: `SecAdapter.resolveByName` (scans the ticker index, instance-cached). The UI shows an
**EDGAR-verified** badge per proposed entity.

## 2. The analyst desk (`lib/engines/research.ts`)
Multi-perspective + synthesized + adversarially checked — replaces the single thesis call:
- **Expert lenses** (Sonnet, parallel): equity, sector, technology, risk — each a specialist persona
  returning a structured contribution with claims (statement + basis + confidence) and risks.
- **Senior synthesis** (Opus): reconciles the panel into the house thesis with measurable
  invalidation triggers + the load-bearing claims to fact-check.
- **Adversarial verification** (Opus): a skeptic judges each claim against the evidence
  (supported / unverified / contradicted), scores overall **confidence + missing-sources**, and
  recommends **auto** vs **review**. Low confidence blocks auto-publish (spec §8) → routes to the
  human checkpoint. Confidence promoted to `canonical_snapshots.confidence` (migration 0011).
- Tolerant confidence parsing (models emit 0.85 / 85 / "0.85"); bounded output to avoid truncation;
  lens failures are logged, not silently swallowed.

## Wiring
The coverage pass now: deterministic XBRL model → MD&A drivers → Monte Carlo → **desk** (panel →
synthesis → verification) → snapshot with `content.research` (panel + verdicts) + confidence +
needs-review. The Company screen renders the **Analyst desk** panel: each lens + confidence, the
verification recommendation, a low-confidence review banner, and the missing-sources list.

## Live proof (AAPL 10-Q, full tiered pipeline, ~$0.36)
- Resolution: Cerebras → **CBRS, listed, EDGAR-verified**; Groq/Tenstorrent → pre_ipo S-1 filers.
- Desk: 4 lenses (equity 66% / sector 71% / technology 71% / risk 61%); thesis flagged **review**
  (confidence 0.60); adversarial verifier marked **6 of 12 claims unverified** — e.g. "Services GM
  ~72-75% (analyst estimate, not in XBRL)", "China revenue ~17-19%", "C1 modem/Qualcomm dependency"
  — separating XBRL-grounded facts from unsourced narrative.

## 68/68 tests
Intake: `verifyEntity` corrects an LLM mislabel (public name claimed "private" → listed — the
Cerebras class); resolution verified against EDGAR. Coverage: the desk (fake panel) flows into the
snapshot with confidence + verification + needs-review gating.

## Open items
- The **private profile** path still uses the lighter single Perplexity pass (the full desk runs on
  coverage — listed/pre-IPO with filings). Applying the desk to profiles is a cost/value call (each
  desk run ≈ $0.35); deferred.
- Foreign-listed names (e.g. SK Hynix, TSMC ADR aside) verify as unverified/pre_ipo edge cases — a
  non-EDGAR identity source would tighten this.
