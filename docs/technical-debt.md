# Technical Debt Log

**Phase:** 3 (Outcome Intelligence & Continuous Evaluation)  
**Last updated:** 2026-07-13  
**Owner:** Platform / Signal Engine team

---

## Remaining Failing Tests

Baseline from `docs/test-debt.md` (2026-07-09). The **signals gate** (`npm run test:signals-gate`) is green and blocking. Full suite (`npm test`) is non-blocking until Bucket A is cleared.

| File | Failures | Owner | Severity | Planned Phase |
|------|----------|-------|----------|---------------|
| `dashboardUiContracts.vitest.ts` | 28 | Frontend | Low | Phase 1 — rewrite or delete regex contracts |
| `closedMarketDedup.vitest.ts` | 12 | Signals | Medium | Phase 1 — align with `confirmedSignalPolicy` constants |
| `nifty500Universe.vitest.ts` | 10 | Data Platform | Medium | Phase 1 — align with NSE1000 rebuild |
| `resolverFallbackPolicy.vitest.ts` | 7 | Market Data | Medium | Phase 1 — dual-source ladder spec |
| `scheduler.vitest.ts` | 5 | Workers | Low | Phase 1 — IST window assertions |
| `providerReport.vitest.ts` | 5 | Market Data | Low | Phase 1 |
| `topLosersFix.vitest.ts` | 4 | Frontend | Low | Phase 1 — quarantined in `test:contracts` |
| `resolverCacheFirst.vitest.ts` | 3 | Market Data | Medium | Phase 1 |
| `noTradePrecedence.vitest.ts` | 2 | Signals | Medium | Phase 1 |
| `closedMarketFreshnessProbe.vitest.ts` | 2 | Signals | Low | Phase 1 |
| `closedMarketAdaniRouting.vitest.ts` | 2 | Signals | Low | Phase 1 |
| `probeCandleHealth.vitest.ts` | 1 | Data Platform | Low | Phase 2 — needs DB fixtures |
| `nseUniverseRanker.vitest.ts` | 1 | Data Platform | Low | Phase 1 |
| `manipulationSchedulerE2E.vitest.ts` | 1 | Surveillance | Low | Phase 2 — env/DB bootstrap |
| `manipulationScannerCliAcceptance.vitest.ts` | 1 | Surveillance | Low | Phase 2 |
| `historicalMarketMovers.vitest.ts` | 1 | Market Data | Low | Phase 1 |
| `dailyReportMarketMovers.vitest.ts` | 1 | Frontend | Low | Phase 1 — quarantined |
| `architectureFreeze.vitest.ts` | 1 | Platform | Medium | Phase 1 — allow-list dual-source |

**Severity key:** High = blocks deploy; Medium = spec drift on signal/market path; Low = UI contracts or DB-dependent.

---

## Build & Config Debt

| Item | Owner | Severity | Phase | Status |
|------|-------|----------|-------|--------|
| `ignoreBuildErrors` removed from `next.config.js` | Platform | High | **0** | **Resolved** |
| `ignoreDeprecations` removed from `tsconfig.json` | Platform | Low | **0** | **Resolved** |
| Legacy `getLivePrice.ts` still used by non-signal APIs | Market Data | Medium | Phase 1 | Open |
| `customUniverseBatchScanner` Yahoo path | Signals | Medium | Phase 1 | Deprecated — use canonical pipeline |
| `outcomeLearningEngine.ts` orphaned | Signals | Low | Phase 1 | Deprecated Phase 0 |

---

## Operational Debt

| Item | Owner | Severity | Phase |
|------|-------|----------|-------|
| ~~`check:signal-consistency` LGEINDIA/PFC mismatches~~ | Signals | Medium | **Resolved Phase 1** — `getAuthoritativeSignalRow` + `preferredDirection` |
| `check:signal-consistency` stale-candle `NO_TRADE` on closed market (ARE&M, etc.) | Signals | Low | Expected — live staleness gate; not a consistency bug |
| Full Vitest suite ~87 failures | Platform | Low | Phase 1 |
| `.env.local` corrupted lines in some dev copies | Platform | Low | **0** — maintain a private backup of `.env.local` |
| Confidence 80–89 bucket has 0% observed wins over 95 legacy outcomes | Analytics | Medium | Phase 3 report finding — investigate source population before any calibration change |
| Revalidation reason append can truncate `reason_type` for LGEINDIA/PFC | Signals | Low | Existing persistence enum/schema mismatch; consistency result remains green |

---

## CI Commands (Phase 0 Gate)

| Command | Blocking | Expected |
|---------|----------|----------|
| `npm run typecheck` | Yes | Green |
| `npm run lint` | Yes | Green |
| `npm run build` | Yes | Green |
| `npm run test:signals-gate` | Yes | Green (112 tests incl. scoring regression) |
| `npm run validate:signal-engine-functional` | Yes | PASS |
| `npm run check:signal-consistency` | Yes | Green (2026-07-14: 10/10 consistent) |
| `npm run test:feature-consistency` | Post–Phase 0 | Green (3 tests) |
| `npm run test:market-data-integrity` | Post–Phase 0 | Green (5 tests) |
| `npm run test:signal-determinism` | Post–Phase 0 | Green (2 tests) |
| `npm run test:trade-plan` | Post–Phase 0 | Green (4 tests) |
| `npm run test:confidence-calibration` | Post–Phase 0 | Green (4 tests) |
| `npm run test:rejection-engine` | Post–Phase 0 | Green (3 tests) |
| `npm run benchmark:signal-quality` | Informational | Phase 1 vs Phase 2 replay comparison |
| `npm run test:outcome-intelligence` | Post–Phase 0 | Green (4 tests) |
| `npm run test:learning-snapshots` | Post–Phase 0 | Green (3 tests) |
| `npm run test:performance-reporting` | Post–Phase 0 | Green (4 tests) |
| `npm run benchmark:confidence-calibration` | Informational | 61,970 outcomes; Brier 0.248213; ECE 0.07815 |

Non-blocking full-suite debt: [`docs/product-a/phase-0-test-debt.md`](./product-a/phase-0-test-debt.md). Local MySQL rotation completed 2026-07-14; remaining upstream keys (Kite/Redis/Resend/News) stay on the operator checklist in `docs/security/credential-rotation.md`.

---

## Rules for New Debt

1. Add a row here before merging known-failing tests.
2. Signal-path tests must land in `test:signals-gate` once green.
3. Policy floor assertions must import constants — never hardcode values.
