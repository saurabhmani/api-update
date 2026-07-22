# AI Map — Architecture (compact)

> Audited 2026-07-17 against the repository. Full detail: root `ARCHITECTURE.md`.
> Do not invent behavior. Prefer exact paths/symbols. Label unknowns as `Unknown` / `Not found` / `Needs verification`.

## System shape

- **Style:** Next.js 16 App Router modular monolith + supervised worker children (`server.js`).
- **Runtime DB:** MySQL (`src/lib/db.ts`). PostgreSQL is sidecar/migrations (`src/lib/db/postgres.ts`).
- **Cache:** Redis (`src/lib/redis.ts`) or memory when `REDIS_DISABLED`.
- **Prod entry:** `pm2` → `ecosystem.config.js` → `node server.js` (ports **5000** HTTP, **5001** WS).
- **Not prod path:** `npm start` (`next start -p 3000`); `services/*` microservice scaffolds.

## Layering

```
Browser → src/proxy.ts (cookie presence)
       → src/app pages | src/app/api/**/route.ts
       → src/services (orchestration)
       → src/lib (engines + infra)
       → src/providers | MySQL | PG | Redis
```

## Inventory (verified counts)

| Asset | Count | Path |
|---|---:|---|
| API `route.ts` | 319 | `src/app/api` |
| Pages | 59 | `src/app/**/page.tsx` (50 `'use client'`) |
| Components | 76 files (71 `.ts`/`.tsx`) | `src/components` |
| Hooks | 21 | `src/hooks` |
| Services | 44 | `src/services` |
| `withApiHandler` routes | 55 | `src/lib/apiHandler.ts` |
| `requireSession` route files | 204 | `src/lib/session.ts` |
| `requireAdmin` route files | 36 | `src/lib/session.ts` |
| Scripts | 141 | `scripts/` |

## Runtime topology

| Process | Owner | File |
|---|---|---|
| Next.js HTTP | `server.js` | `PORT` default 5000 |
| WS stream | `instrumentation.ts` | `STREAM_WS_PORT` default 5001 |
| Scheduler (long-running) | `server.js` child | `src/lib/workers/scheduler.ts` |
| Manipulation one-shot | cron `0 13 * * *` UTC | `manipulationScannerCli.ts` |
| Learning one-shot | cron `0 15 * * *` UTC | `learningScheduler.ts` |

`server.js` forces `Q365_INPROC_SCHEDULER=0` when unset so Next does not double-register crons.

## Market-data cascade (execution order)

`src/lib/marketData/resolver/marketDataResolver.ts` → `resolveBatch`:

1. Market-closed gate (no upstream)
2. NIFTY500 lock
3. Cache
4. **Kite**
5. **NSE direct** (after consecutive true-failures)
6. **Yahoo emergency** (`YAHOO_EMERGENCY_FALLBACK_ENABLED`, default true)
7. Degraded / none / snapshot

Note: `getPrimaryFallbackProvider('kite')` returns descriptive `yahoo|nse|db` — **not** call order.

## Signal write vs read

| Path | Entry | Persist |
|---|---|---|
| Write/scan | `dailyScanSchedule.ts` / `POST /api/run-signal-engine` | `q365_signals` + maturity tracker (`dbOnly: true` candles on schedule) |
| Promote | `src/lib/cron/signalMaturity.ts` (60s) | **only** writer of `q365_confirmed_signal_snapshots` via `insertConfirmedSnapshotIfEligible` |
| Lifecycle | `confirmedSnapshotLifecycle.ts` (30s) | status mutations only |
| Read | `GET /api/signals` | reads snapshots → gates → tiers (`responseAssembly.ts`) |

## Recovery mode

- Symbol: `getIntelligenceMode(marketOpen, status)` in **`src/types/dashboard.ts`**
- Condition: `status === 'BROKEN' || status === 'AUTH_REQUIRED'` → `'RECOVERY'`
- Health nodes: `src/lib/signals/engineHealthMap.ts`

## Schema facts

- Boot ensure: `ensureSchemasSafely()` → `ensureAllSchemas` + `ensureSignalEngineSchemas`
- `market_data_daily` is a **VIEW** over EOD `candles` (`ensureSchemas.ts`)
- Candle key: `NSE_EQ|SYMBOL`
- Critical signal columns: `composite_final_score`, `classification`, `phase4_factor_scores_json` (add column **before** index)

## Auth

- Cookie: `q200_session` (httpOnly, sameSite=lax)
- MySQL `user_sessions` authoritative; Redis `session:${token}` TTL **300s**
- `SESSION_MAX_AGE` default 86400; `MAX_SESSIONS_PER_USER` default 5
- Proxy = cookie presence only; real auth = per-route guards

## Companion maps

- `docs/ai/conventions.md`
- `docs/ai/workflows.md`
- `docs/ai/invariants.md`
- `docs/ai/troubleshooting.md`
- `docs/ai/change-impact-map.md`
