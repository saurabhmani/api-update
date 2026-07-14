# Phase 0 — Non-Blocking Test Debt

**Owner:** Platform / Signal Engine team  
**Updated:** 2026-07-14  
**Blocking gate:** `npm run test:signals-gate` only (must remain green)  
**Non-blocking:** Full suite (`npm test` / remaining vitest files)

Known failing or unsupported tests outside the Phase 0 acceptance gate must not block Phase 0 completion. Track them here with an owner and resolution phase.

| Area / suite | Owner | Severity | Resolution phase | Notes |
|--------------|-------|----------|------------------|-------|
| `dashboardUiContracts.vitest.ts` | Frontend | Low | Phase 1+ | Regex UI contracts drift |
| `closedMarketDedup.vitest.ts` | Signals | Medium | Phase 1+ | Align with `confirmedSignalPolicy` |
| `nifty500Universe.vitest.ts` | Data Platform | Medium | Phase 1+ | NSE1000 rebuild assumptions |
| `resolverFallbackPolicy.vitest.ts` | Market Data | Medium | Phase 1+ | Post-Gate-Z ladder |
| `scheduler.vitest.ts` | Workers | Low | Phase 1+ | IST window windows |
| `providerReport.vitest.ts` | Market Data | Low | Phase 1+ | Report shape |
| `topLosersFix.vitest.ts` | Frontend | Low | Phase 1+ | Quarantined in contracts |
| `resolverCacheFirst.vitest.ts` | Market Data | Medium | Phase 1+ | Cache-first policy |
| Remaining full-suite vitest failures (~Bucket A in `docs/technical-debt.md`) | Platform | Low | Phase 1+ | Non-blocking until Bucket A cleared |
| `outcomeLearningEngine.ts` port of optional metrics | Signals | Low | Phase 1 | Deprecated module kept for inventory only |
| Legacy `getLivePrice.ts` non-signal consumers | Market Data | Medium | Phase 1+ | Signal path uses `marketDataResolver` |

Canonical debt log: [`docs/technical-debt.md`](../technical-debt.md).

**Rule:** Do not add signal-critical regressions outside `test:signals-gate` without an owner and target phase.
