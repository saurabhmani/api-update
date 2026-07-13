# Test Debt Tracker

Triage of the failing Vitest suite (baseline: 2026-07-09, ~87 failures
across 18 files out of 705 tests). The **signals gate**
(`npm run test:signals-gate`) is green and is the only blocking suite;
everything below is tracked debt with an assigned bucket and action.

Buckets:

- **A — Signals/market-data behavioral**: real behavior tests whose
  assertions drifted from the current spec (mostly policy floor
  changes). Fix by re-reading the exported constants, not by loosening
  the code. Priority before production sign-off.
- **B — UI source-regex contracts**: `readFileSync` + regex on
  page/component source. Quarantined into `npm run test:contracts`
  (non-blocking). Refactor to behavioral tests or delete when the UI
  they froze has been redesigned.
- **C — Env/DB-dependent**: read `.env.local` or expect a live MySQL.
  Mock or guard with `describe.skipIf(!process.env...)` for CI.
- **D — Stale spec assertions**: assert code that was intentionally
  removed (e.g. dashboard early-signal badge). Update or delete.

## Fixed in this pass (now in the signals gate)

| File | What was wrong | Fix |
|------|----------------|-----|
| `src/__tests__/eliteInstitutionalGate.vitest.ts` | Asserted `VALID_SIGNAL` rejected from elite (re-added by MATURATION_AUDIT_2026-05) and asserted never-empty fallback ON by default (now defaults OFF) | Updated to current spec; added explicit `SIGNAL_ELITE_NEVER_EMPTY=1` opt-in test |
| `src/__tests__/closedMarketSignalsExpiry.vitest.ts` | Dashboard early-signal badge block asserted source removed in the Command Center refactor | Removed the dashboard describe; the badge contract remains for the Signals page |

## Outstanding failures by file

| File | Failures | Bucket | Notes / action |
|------|----------|--------|----------------|
| `dashboardUiContracts.vitest.ts` | 28 | B | Regex contracts on `src/app/dashboard/page.tsx` from a prior dashboard design (grid3/section classes, compact previews, ModelBiasPill). Quarantined in `test:contracts`. Rewrite as component tests or drop. |
| `closedMarketDedup.vitest.ts` | 12 | A | Floor drift: asserts old floors (confidence 75, final 70, rr 2, maturity 85, edge 2) for `mainTableApproved` / `earlySignalApproved` / `relaxedMainTableApproved` / `strictValidationFilter`; floors were relaxed and made env-tunable in `src/lib/signals/confirmedSignalPolicy.ts`. Also `normalizeClassification(80)` now buckets to VALID_SIGNAL band. Rewrite against the exported `*_FLOOR` constants. |
| `nifty500Universe.vitest.ts` | 10 | A/C | Universe sync behavior; uses vi.mocked db but assertions drifted from current loader (NSE1000 rebuild). Re-align with `weeklyNse1000UniverseRebuild` behavior. |
| `resolverFallbackPolicy.vitest.ts` | 7 | A | Resolver fallback ladder changed with dual-source introduction; update expected provider ordering. |
| `scheduler.vitest.ts` | 5 | A/C | Scheduler window assertions; verify against current IST windows in `src/lib/workers/scheduler.ts`. |
| `providerReport.vitest.ts` | 5 | A | Provider usage report shape drifted. |
| `topLosersFix.vitest.ts` | 4 | B | Regex on `dashboard/page.tsx` movers block that was refactored. Quarantined in `test:contracts`. |
| `resolverCacheFirst.vitest.ts` | 3 | A | Cache-first resolver ordering drift. |
| `noTradePrecedence.vitest.ts` | 2 | A | NO_TRADE precedence expectations vs relaxed-mode changes. |
| `closedMarketFreshnessProbe.vitest.ts` | 2 | B | Source-regex on `/api/signals` closed path (`getTrackerCounts` wiring string match). Convert to behavioral test of the freshness payload. |
| `closedMarketAdaniRouting.vitest.ts` | 2 | A/B | Mixed: one behavioral promotion rule, one SQL-string regex. |
| `probeCandleHealth.vitest.ts` | 1 | C | Requires candle DB fixtures. |
| `nseUniverseRanker.vitest.ts` | 1 | A | Ranker tie-break drift. |
| `manipulationSchedulerE2E.vitest.ts` | 1 | C | Suite-level failure (env/DB bootstrap). |
| `manipulationScannerCliAcceptance.vitest.ts` | 1 | C | CLI acceptance needs DB. |
| `historicalMarketMovers.vitest.ts` | 1 | A | Movers coercion drift. |
| `dailyReportMarketMovers.vitest.ts` | 1 | B | Report movers source contract. Quarantined in `test:contracts`. |
| `architectureFreeze.vitest.ts` | 1 | D | Direct `*Adapter` import introduced outside `src/providers/**` (dual-source module). Either allow-list `src/lib/marketData/dualSource/**` or route through `MarketDataProvider`. |

## Suites

| Command | Purpose | Blocking? |
|---------|---------|-----------|
| `npm run test:signals-gate` | Signal-critical behavioral tests (8 files, 108 tests) | Yes — CI + pre-deploy |
| `npm run test:contracts` | Quarantined UI source-regex contracts | No — informational |
| `npm test` | Full Vitest suite | No — until buckets A are re-aligned |

## Rules for new tests

1. New signal-path tests go into the gate list in `package.json`
   (`test:signals-gate`) once green.
2. Prefer behavioral tests over source-regex. A source contract is
   acceptable only for load-bearing invariants (e.g. "all three layers
   import `filterDisplayableApproved`" in
   `src/__tests__/displayableCountParity.vitest.ts`).
3. Tests that assert numeric policy floors must import the exported
   constants from `confirmedSignalPolicy.ts`, never hardcode values.
