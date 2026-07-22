# AI Map — Troubleshooting

> Audited 2026-07-17. Prefer these playbooks before broad refactors.

## A. Production `RECOVERY` / Recovery Mode

**Symptom:** Dashboard intelligence mode = Recovery; engines show broken.

**Decision function:** `getIntelligenceMode` in `src/types/dashboard.ts` → `RECOVERY` when status is `BROKEN` or `AUTH_REQUIRED`.

**First checks:**

```bash
# With valid q200_session cookie against the live host:
curl -sS -H "Cookie: q200_session=<token>" "https://<host>/api/signals?action=all&limit=5" | head
curl -sS -H "Cookie: q200_session=<token>" "https://<host>/api/signals/engine-health" | head
```

| Observation | Likely cause | Fix |
|---|---|---|
| HTTP 500 `Unknown column '….composite_final_score'` (or `classification`) | Schema drift on `q365_signals` | `npm run db:ensure` **or** `ALTER TABLE` add columns **then** create indexes |
| HTTP 401 | Wrong/missing cookie (`q200_session`, not `q365_session`) | Re-login; confirm cookie name |
| HTTP 200 but approved = 0 | Empty warehouse / no promotions | See §B and §C |

## B. Approved signals = 0

Trace order:

1. `SELECT COUNT(*) FROM q365_signals;`
2. Status / `signal_status` / `classification` distributions.
3. `SELECT COUNT(*) FROM q365_confirmed_signal_snapshots WHERE status=…;`
4. `SELECT COUNT(*) FROM market_data_daily;` / `candles` depth.
5. Maturity worker logs (`promoted=`, DQ gate).

| First divergence | Fix |
|---|---|
| No/few candles | Configure `KITE_*`; `npm run candles:backfill:batch` + `candles:daily` |
| Signals exist, snapshots empty | Maturity thresholds / DQ gate / classification whitelist — inspect `signalMaturity.ts` logs |
| Snapshots exist, API empty | Strict/elite/manipulation gates or cap — check `SIGNAL_API_STRICT_*`, `ELITE_GATE`, `Q365_CONFIRMED_CAP` |

## C. Universe not ready

Boot may continue with degraded universe; scans throw `UNIVERSE_NOT_READY`.

```bash
npx tsx scripts/weeklyNse1000UniverseRebuild.ts --bootstrap
# or: npm run rebuild:nse1000-universe:bootstrap
```

Confirm: `SELECT COUNT(*) FROM q365_universe WHERE is_active=1;`

## D. Daily report / backtest > 8s or timeouts

| Suspect | Location | Mitigation already in code |
|---|---|---|
| Nested `/api/signals` | `engineSignalsPayload.ts` | 5s TTL cache, 4s nested timeout |
| Non-sargable candle SQL | `historicalMarketData.ts` | Use `instrument_key IN` + `ts` range |
| Embedded backtest | daily-report route | Skips when `RESPONSE_BUDGET_MS` (7500) exhausted |

Validate with `ApiPerfTracker` marks in route logs.

## E. Double cron / quota burn

Cause: Next process and scheduler both registering jobs.

- Prod: `server.js` must keep `Q365_INPROC_SCHEDULER=0`.
- Dev: set `Q365_INPROC_SCHEDULER=1` only when not also running `npm run scheduler`.

## F. Live prices null / stale

1. Market open? Closed → resolver returns `MARKET_CLOSED` / snapshot — expected.
2. `KITE_API_KEY` / `KITE_ACCESS_TOKEN` present?
3. Fallback flags: `NSE_DIRECT_FALLBACK_ENABLED`, `YAHOO_EMERGENCY_FALLBACK_ENABLED`.
4. WS: `STREAM_WS_DISABLED`? Port `STREAM_WS_PORT`?

## G. Auth failures

| Symptom | Check |
|---|---|
| Proxy 401 on API | Cookie missing (`proxy.ts`) |
| Handler 401 | Expired session / inactive user (`getSession`) |
| Lockout | `users.failed_login_attempts` / `locked_until` (5 fails → 30 min) |
| MFA loop | `totp_enabled` + `verifyTotp` window |

## H. PG migration surprises

- Runner: `src/lib/db/postgres/migrate.ts` discovers `*.sql` not starting with `_`.
- `*.sql.proposal` **not** applied.
- `031_quant_platform.sql` and `031_quant_platform_rollback.sql` share version **031** — rollback file is skipped after forward apply.

## I. Quick health commands

```bash
npm run db:status
npm run validate:engines-health
npm run validate:signal-engine-status
npm run test:engine-health:offline
npx vitest run src/__tests__/engineHealthStatus.vitest.ts
```
