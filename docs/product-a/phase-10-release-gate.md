# Phase 10 — Product A Release Gate

**Status:** Conditional pass (Product A path)  
**Date:** 2026-07-14  
**Gate version:** `10.0.0`  
**Product:** Quantorus 365 Product A — Manual Signal Experience  

## Verdict

| Scope | Verdict |
|-------|---------|
| Product A technical gates (typecheck, lint, build, signals-gate, Product A unit suite, engine validators, Fibonacci validators) | **PASS** |
| Full-repo `npm run test:unit` | **FAIL** — 64 failures / 1015 tests (mostly non–Product-A surfaces; tracked below) |
| Marketing “78% win rate” claim | **NOT ALLOWED** until Section 2 evidence rules are met |

Release of Product A may proceed with **honest marketing wording only** (see below). Do not advertise a fixed win-rate claim.

---

## Mandatory technical gates

| Gate | Script (existing) | Result (2026-07-14) |
|------|-------------------|---------------------|
| Typecheck | `npm run typecheck` | PASS |
| Lint | `npm run lint` | PASS |
| Build | `npm run build` | PASS (after client-safe Product A contract fix) |
| Signals gate | `npm run test:signals-gate` | PASS — 112 tests |
| Product A unit suite | `npm run test:product-a-release` | PASS — 157 tests |
| Full unit suite | `npm run test:unit` | FAIL — 64 failed / 951 passed (advisory for Product A release until green) |
| Signal engine functional | `npm run validate:signal-engine-functional` | PASS (6/7; HTTP auth criterion skipped offline) |
| Signal engine status | `npm run validate:signal-engine-status` | PASS — 6/6 |
| Engines health | `npm run validate:engines-health` | PASS data-plane; signal-plane nodes WARN without live server (expected offline) |
| Signal consistency | `npm run check:signal-consistency` | PASS — 0 failures (advisory empty BUY pool OK) |
| Signals UI | `npm run validate:signals-ui` | PASS / `PARTIALLY_FIXED_NEEDS_HTTP_RUN` |
| Fibonacci pipeline | `npx tsx scripts/validateFibonacciPipeline.ts` | PASS — 3/3 (selective no-trade accepted under Phase 5 regime rules) |
| Fibonacci backtest performance | `npx tsx scripts/validateFibonacciBacktestPerformance.ts` | PASS |

Orchestrator (chains the above; does **not** duplicate validators):

```bash
npm run validate:product-a-release
# optional: --skip-build --skip-unit
```

Writes `releases/product-a-gate-YYYY-MM-DD.json` (folder is gitignored).

---

## Mandatory quality gates

| Gate | Status | Evidence |
|------|--------|----------|
| No critical data-quality defects in Product A path | PASS (with notes) | Seed candles no longer end on “today”; incomplete last-bar defect fixed in fib seed helper |
| No look-ahead leakage | PASS (behavioral) | Phase 5/7 tests + confirmed-swing as-of guards |
| Production / backtest parity | PASS (contract) | Phase 7 parity module + `test:phase7` |
| Elite signals pass Phase 3 approval | PASS (policy) | Elite gate + Phase 3 still authoritative; no-trade valid |
| Confidence calibration report available | PASS | `/api/strategies/performance` transparency + calibration artifacts / docs |
| Strategy health report available | PASS | Strategy health ledger + performance page health labels |
| OOS robustness report available | PASS | Phase 7 walk-forward / robustness docs + tests |
| Signal counts consistent (worker → DB → API → UI) | PASS (gates) | `displayableCountParity`, `check:signal-consistency`, assembly counters |
| No secret / local env in release package | PASS | `.env*` gitignored; not tracked |
| No unresolved P0/P1 **Product A** signal-correctness defect | PASS with follow-ups | Outcome version test aligned to `8.0.0`; full-repo unit fails listed as debt |

### Full `test:unit` debt (not Product A release blockers unless signal path)

Observed failures include (non-exhaustive): `dashboardUiContracts`, `historicalMarketMovers`, `nifty500Universe` (DB size), `noTradePrecedence`, `topLosersFix`, `nseUniverseRanker`, `scheduler` (provider label). Track separately; do not hide by forcing Product A gate green via skips without recording advisory status.

---

## Product performance gate — marketing

**Do not market “78% win rate”** until evidence rules in `docs/product-a/strategy-version-approval.md` are satisfied (OOS headline, sample size, CI low/high).

Allowed wording for this release:

> Quantorus 365 provides selective, evidence-ranked trading signals with transparent backtesting, confidence calibration and manual trade plans.

Product A principles enforced:

- No-trade is a valid output.
- Scarcity is intentional.
- Manual execution only (no broker automation in Product A).

---

## Fixes applied during this gate

| Change | Why |
|--------|-----|
| `productASignalContract` no longer imports `strategyRegistry` | Client `/signals/[key]` was pulling `mysql2` into the Next webpack client graph — **build failed** |
| Fibonacci seed `tradingDaysBack` ends on prior day | Same-day last bar treated incomplete by Phase 1 DQ |
| Fibonacci pipeline criteria accept selective no-trade | Aligns with Phase 5 Sideways disable / Product A selectivity |
| `outcomeIntelligence` expects outcome version `8.0.0` | Matches Phase 8 lifecycle version bump |

---

## How to re-run before any production cut

```bash
npm run typecheck
npm run lint
npm run build
npm run test:signals-gate
npm run test:product-a-release
npm run validate:signal-engine-functional
npm run validate:signal-engine-status
npm run validate:engines-health
npm run check:signal-consistency
npm run validate:signals-ui
npx tsx scripts/validateFibonacciPipeline.ts
npx tsx scripts/validateFibonacciBacktestPerformance.ts

# Full orchestrator
npm run validate:product-a-release -- --skip-unit   # skip advisory full unit
```

---

## Definition of done (this phase)

- [x] Existing validators reused (no duplicate engine scripts invented for naming)
- [x] Technical Product A path green
- [x] Release documentation updated
- [x] Honest marketing wording locked
- [ ] Full-repo `test:unit` green (remaining debt)
- [ ] Live HTTP UI + engine-health pass on a running authenticated server before customer cutover

**Product A phases 0–10 complete for acceptance with the conditional notes above.**
