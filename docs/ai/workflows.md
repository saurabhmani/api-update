# AI Map — Workflows

> Audited 2026-07-17. Step lists cite exact entry files.

## 1. Local development boot

```bash
cp .env.example .env.local   # fill MYSQL_*, SESSION_SECRET, optional Kite
npm ci
npm run db:ensure
npm run dev                  # next dev; set Q365_INPROC_SCHEDULER=1 for in-proc crons
```

Boot hook: `src/instrumentation.ts` `register()` (nodejs runtime only) — env check, `envSafetyLock`, schema ensure, live feed + WS, universe load, candle scheduler, optional `bootInProcScheduler`.

## 2. Production deploy

```bash
npm ci && npm run build
# APP_DIR=/var/www/api-update (or export)
mkdir -p "$APP_DIR/logs"
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

Nginx proxies `/` → `:5000`, `/ws` → `:5001` (`nginx.conf`). Parent process: `server.js`.

## 3. Signal generation (write path)

1. Trigger: IST cron in `src/lib/workers/dailyScanSchedule.ts` **or** `POST /api/run-signal-engine`.
2. Candles: scheduled scans use **`dbOnly: true`** (warehouse only).
3. Pipeline: Phase 3 → Phase 4 (+ Phase 11) inside `src/lib/signal-engine/`.
4. Persist: `saveSignals` → `q365_signals` + maturity tracker upserts.
5. **Does not** write confirmed snapshots.

## 4. Signal promotion (maturity)

1. Interval: 60s from `scheduler.ts` / `bootInProc.ts`.
2. Worker: `src/lib/cron/signalMaturity.ts` → `insertConfirmedSnapshotIfEligible` (`confirmedSnapshots.ts`).
3. Thresholds: `MATURITY_MATURE_THRESHOLD` (70), `MATURITY_MIN_CYCLES` (3), `MATURITY_STABILITY_RAW_FLOOR` (0.55), `MATURITY_PROMOTE_THRESHOLD`; regime gate **hardcoded 0.5**.
4. Lifecycle (30s): `confirmedSnapshotLifecycle.ts` mutates status only.

## 5. Signal board read (`GET /api/signals`)

1. `requireSession()` (`src/app/api/signals/route.ts`).
2. Load confirmed snapshots → `enrichWithLiveLtp` / `resolveBatch` (~`SIGNALS_ENRICH_TIMEOUT_MS` 5000).
3. Strict gate → elite gate → manipulation gate → tier partition (`responseAssembly.ts`, `confirmedSignalPolicy.ts`).
4. Empty approved stays empty (no fallback scan of `q365_signals`).

## 6. Daily report / backtest preview (≤8s budget)

1. Routes: `src/app/api/signals/daily-report/route.ts`, `.../backtest/route.ts`.
2. Nested signals via `fetchEngineSignalsPayload` (`engineSignalsPayload.ts`: **4s** timeout, **5s** TTL cache).
3. `RESPONSE_BUDGET_MS = 7500`; embedded backtest skipped when remaining budget too low.
4. Candle SQL must stay sargable (`historicalMarketData.ts`: `instrument_key IN (?)`, `ts` range — no `DATE(ts)` / `UPPER(SUBSTRING_INDEX(...))` in WHERE).

## 7. Outcome evaluation / learning

1. 20:00 IST cron / `POST /api/signal-engine/feedback/evaluate`.
2. Core: `src/lib/signal-engine/feedback/runOutcomeEvaluation.ts` → `q365_signal_outcomes`.
3. 20:30 IST: `learningScheduler.ts` one-shot from `server.js`.

## 8. Universe + candles

```bash
npx tsx scripts/weeklyNse1000UniverseRebuild.ts --bootstrap   # if q365_universe empty
npm run candles:backfill:batch   # needs Kite creds
npm run candles:daily
```

Universe source of truth: `q365_universe(is_active=1)`; seed/file helpers in `nifty500Universe.ts` / `active_stocks.json`.

## 9. Login / session

1. `POST /api/auth` → `loginUser` (bcrypt; lockout after 5 failures / 30 min).
2. Optional TOTP → `verifyTotp` → `createSession` → cookie `q200_session`.
3. Subsequent requests: `proxy.ts` cookie check → route `requireSession()` → Redis then MySQL.

## 10. Institutional decision (pre-trade)

1. Entry: `src/services/decisionOrchestrator.ts` `evaluateInstitutionalDecision`.
2. Gates: breach → portfolio fit → risk → governance → scenario → explain → audit.
3. Guard: `decisionContext.assertOrchestratorContext()` — do not call risk/governance bypasses directly.
4. Persist: `decisionTraceBuilder.ts`.

## 11. Add a safe feature (checklist)

1. Place files per `docs/ai/conventions.md`.
2. Add `requireSession`/`requireAdmin` as needed.
3. Prefer `withApiHandler`.
4. Schema: column before index; `npm run db:ensure`.
5. Validate: `npm run typecheck && npm run test:signals-gate` (if signals-touching) && targeted vitest.
6. Update `docs/ai/change-impact-map.md` if crossing a paired-change boundary.
