# AI Map — Change Impact Map

> Audited 2026-07-17. When you touch a left-hand file/area, update the paired right-hand artifacts together.

## Paired changes (must change together)

| If you change… | Also update… | Validate with |
|---|---|---|
| `migrateSignalEngine.ts` / `q365_signals` DDL | `saveSignals.ts`, read-path consumers (`responseAssembly.ts`, gates), indexes **after** columns | `npm run db:ensure`; hit `/api/signals`; `test:signals-gate` |
| `confirmedSignalPolicy.ts` floors / caps | `src/__tests__/*` gate tests; env docs / `.env.example` if exposing new knobs | `npm run test:signals-gate` |
| `signalMaturity.ts` / maturity thresholds | `maturityScorer.ts`, `confirmedSnapshots.ts`, debug maturity route | maturity unit tests; inspect promote logs |
| `marketDataResolver.ts` cascade | `providerFlags.ts`, boot logs in `instrumentation.ts`, any caller assuming provider id strings | market-data / dual-source / live-feed vitests |
| `providerFlags.ts` | Resolver, live feed (`getLiveFeedProvider`), docs/ai cascade notes | `getProviderFlagsSummary` boot line |
| `scheduler.ts` / `dailyScanSchedule.ts` crons | `server.js` ownership, `bootInProc.ts`, `docs/DAILY_SCAN_SCHEDULE.md` | ensure no double cron |
| `proxy.ts` public paths | Auth routes / health endpoints that must stay cookie-free | Manual curl without cookie |
| `session.ts` / cookie name | `auth/route.ts`, `proxy.ts`, OpenAPI security scheme, all clients | login + `/api/auth` me |
| `withApiHandler` envelope | Frontend consumers of that route | contract / page smoke |
| `engineSignalsPayload.ts` / backtest SQL | `daily-report/route.ts`, `backtest/route.ts`, `historicalMarketData.ts`, `signalsBacktestHandler.ts` | budget timing logs; targeted route validation |
| `getIntelligenceMode` / `EngineHealthStatus` | `src/types/dashboard.ts`, dashboard UI, `engineHealthStatus.vitest.ts`, engine-health API mapping | `npx vitest run src/__tests__/engineHealthStatus.vitest.ts` |
| `envSafetyLock.ts` thresholds | File header comment (keep in sync), `.env.example`, ops runbooks | unit/boot under `NODE_ENV=production` |
| RBAC roles | `src/lib/security/types.ts`, `rbac.ts`, **`SessionUser.role` in `session.ts`**, seed/admin UI | security tests |
| Decision orchestrator gates | `decisionContext.ts`, `preTradeGatewayService.ts`, audit/trace writers | decision/governance tests |
| `aiLayerService` / LLM prompts | `aiBoundary.ts` sanitizer | ensure no authoritative fields leak |

## Blast-radius by domain

| Domain | High-risk directories | Downstream |
|---|---|---|
| Signals read | `src/lib/signals/`, `src/app/api/signals/` | Dashboard, SSE stream, daily report, rankings |
| Signals write | `src/lib/signal-engine/`, `workers/dailyScanSchedule.ts` | Maturity, outcomes, learning |
| Market data | `src/lib/marketData/`, `src/providers/` | Enrichment, live WS, scans (indirect via candles) |
| Auth | `src/services/auth.ts`, `src/lib/session.ts`, `src/lib/security/` | Entire authenticated surface |
| Schema | `src/lib/db/**`, `migrations/**` | Every repository; boot ensure |
| Workers | `src/lib/workers/`, `server.js` | Data freshness, promotion, learning |
| Frontend shell | `AppShell.tsx`, `useAuth`, QueryProvider | ~48 pages |

## Safe low-blast changes

- New page under `src/app/<route>` composing existing APIs + `AppShell`
- New `withApiHandler` route that only reads existing services
- SCSS / copy / non-contract UI tweaks
- New vitest covering pure functions

## Unsafe without explicit plan

- Changing promotion ownership (writing snapshots from scanner/saveSignals)
- Re-enabling dual-source or a third-party vendor primary
- Relaxing market-closed gate globally
- Broad `requireSession` removal or making `/api/signals` public
- Editing applied PG migration checksums in place (add a new numbered file instead)
- Renaming `q200_session` without a migration plan for live clients

## Suggested PR checklist (signals-touching)

- [ ] Schema column-before-index if DDL changed
- [ ] `test:signals-gate` green
- [ ] Manual `/api/signals` 200 with session cookie
- [ ] No new in-proc cron under prod (`Q365_INPROC_SCHEDULER`)
- [ ] Docs: update this map + `ARCHITECTURE.md` §21 if counts/invariants changed
