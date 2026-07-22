# AI Map — Invariants

> Audited 2026-07-17. Violating these breaks production behavior or silently corrupts data.

## Hard invariants (must preserve)

| ID | Invariant | Evidence |
|---|---|---|
| I1 | `/api/signals` **reads** confirmed snapshots; it does **not** scan/generate | `src/app/api/signals/route.ts`, `responseAssembly.ts` |
| I2 | **Only** `src/lib/cron/signalMaturity.ts` promotes into `q365_confirmed_signal_snapshots` | Sole caller of `insertConfirmedSnapshotIfEligible` |
| I3 | `confirmedSnapshotLifecycle` mutates status only — no new promotions | `src/lib/cron/confirmedSnapshotLifecycle.ts` |
| I4 | Scheduled scans use **DB-only** candles (`dbOnly: true`) | `dailyScanSchedule.ts` |
| I5 | Single cron owner in prod: Next process must not run in-proc scheduler | `server.js` sets `Q365_INPROC_SCHEDULER=0` |
| I6 | Live quotes flow through `resolveBatch`; market-closed → no upstream | `marketDataResolver.ts` |
| I7 | Provider selection via `providerFlags.ts`, not ad-hoc env reads | `providerFlags.ts` |
| I8 | `dataQuality='LOW'` must stop confirmed-signal generation (caller contract) | Resolver header contract |
| I9 | Real-data-only UI; force-seed disabled | `instrumentation.ts` `BALANCED_REAL_DATA_MODE_ENABLED` |
| I10 | Empty approved set stays empty (no soft-fill from raw `q365_signals`) | Read-path policy / signals-gate tests |
| I11 | Decision risk/governance only inside orchestrator context | `decisionContext.assertOrchestratorContext` |
| I12 | AI must not emit decision-authoritative fields unchecked | `aiBoundary.sanitizeAIOutput` |
| I13 | Schema: add columns **before** indexes that reference them | Historical `classification` index failure → `RECOVERY` |
| I14 | Aggregator endpoints honor ~8s budget | `RESPONSE_BUDGET_MS=7500`, `engineSignalsPayload` |
| I15 | MySQL is the runtime DB for product paths | `src/lib/db.ts` |

## Soft / operational invariants

| ID | Rule |
|---|---|
| S1 | Cookie name remains `q200_session` unless all clients + proxy + auth updated together |
| S2 | Production must not set `FORCE_MARKET_OPEN` / `MOCK_MARKET_OPEN` / `BYPASS_MARKET_HOURS` (`envSafetyLock`) |
| S3 | Production `CANDLE_MAX_PER_CYCLE` ≤ 100; numeric `LEGACY_VENDOR_ENV` ≤ 1500 (code; header comment still says 500) |
| S4 | Manipulation may fire from multiple schedules — treat logs as source of which run executed |
| S5 | Dual-source validation stays force-disabled (`isDualSourceEnabled()` → false) |
| S6 | Do not reintroduce decommissioned vendor adapters as primary |

## Gate floors (defaults; env-overridable)

Strict (`confirmedSignalPolicy.ts`): confidence ≥ **55**, final ≥ **60**, RR ≥ **1.5**, stress ≥ **60**; cap `Q365_CONFIRMED_CAP` default **20** (hard max **30**).

Elite: confidence **70**, final **60**, RR **1.5**; bypass `ELITE_GATE=0`.

Manipulation approval impact only when freshness `FRESH` **and** band ∈ `{ELEVATED, HIGH, SEVERE}`.

## Recovery-mode rule

```ts
// src/types/dashboard.ts
if (status === 'BROKEN' || status === 'AUTH_REQUIRED') return 'RECOVERY';
```

Typical production trigger: `/api/signals` HTTP 500 (e.g. missing `q365_signals.composite_final_score`).

## Forbidden assumptions

- PostgreSQL is **not** the primary runtime store.
- `market_data_daily` is a **VIEW**, not a base table.
- Auth is **not** global — only 204/319 routes call `requireSession`.
- Response envelopes are **not** uniform.
- `winston` is **not** the app logger.
- `getPrimaryFallbackProvider` string is **not** the resolveBatch call order.
- `LEGACY_VENDOR_ENV` does **not** select the market-data provider.
