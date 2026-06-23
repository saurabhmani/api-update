# Daily Scan Schedule (IST)

Four scheduled jobs run on weekdays when `DAILY_SCAN_SCHEDULE_ENABLED=true` (default). Registered by `startDailyScanSchedule()` from the worker process (`npm run scheduler`).

**IndianAPI budget policy:** [PROVIDER_REQUEST_POLICY.md](./PROVIDER_REQUEST_POLICY.md)

## Schedule

| Job | Window | Cron (default) | Mode | Data source | IndianAPI historical |
|-----|--------|----------------|------|-------------|----------------------|
| **Morning Scan** | 08:30–09:00 | `30 8 * * 1-5` | `scan` | `market_data_daily` (DB) | **0** |
| **Evening Update** | 16:00 | `0 16 * * 1-5` | `incremental-update` | IndianAPI | **≤ 1,000** (~1 req/symbol behind target day) |
| **Evening Scan** | 16:30–17:00 | `30 16 * * 1-5` | `scan` | `market_data_daily` (DB) | **0** |
| **Manipulation Scan** | 18:30 | `30 18 * * 1-5` | `scan-only` | `candles` warehouse (DB) | **0** |

### Purpose

- **Morning Scan** — pre-market signals from the last completed daily candle (previous session close).
- **Evening Update** — fetch the latest completed EOD bar for the NSE 1000 universe (`runCandleDailyUpdateJob`). Populates the `candles` warehouse used by downstream engines.
- **Evening Scan** — fresh EOD signals after the evening candle update lands in DB.
- **Manipulation Scan** — surveillance scan via `runDailyScan({ skipIngestion: true })`. Reads candles refreshed at 16:00; **does not** re-run EOD ingestion.

## Execution order (dependency graph)

```
08:30  Morning Scan        (DB-only Phase 4 signals)
         │
16:00  Evening Update      ──► candles warehouse refreshed (IndianAPI)
         │
16:30  Evening Scan        (DB-only Phase 4 signals on fresh EOD)
         │
         │  ← 2h30m slack for ~1,000-symbol fetch
         ▼
18:30  Manipulation Scan   runDailyScan({ skipIngestion: true })
                             └─ scan only; no duplicate ingestion
```

The manipulation job **depends** on the 16:00 Evening Update completing first. The 18:30 slot is deliberately 2h30m after EOD refresh to allow the IndianAPI fetch to finish. If Evening Update overruns, manipulation still runs against the latest warehouse state (warning-only if candles are stale).

At schedule startup, `isManipulationScheduledAfterEodUpdate()` validates that configured cron expressions keep manipulation after 16:00 EOD update.

## Overlap / race guards

| Guard | Scope | Behaviour |
|-------|-------|-----------|
| `guardJob()` | Morning / Evening Update / Evening Scan | One in-flight run per job name; overlapping cron ticks return the existing promise |
| `manipulationDailyScanInFlight` | Manipulation Scan | Second 18:30 tick while a scan is running reuses the in-flight promise |
| Cron `.catch()` handlers | All jobs | A failed job logs and exits; remaining `tasks[]` crons stay registered |
| `tasks.length > 0` check | `startDailyScanSchedule()` | Duplicate bootstrap calls are ignored |

Manipulation scan uses a **separate** overlap guard from signal jobs because it calls `runDailyScan` (not `guardJob`) and must not block or be blocked by Phase 4 signal scans.

## Manipulation scan logs

Greppable console lines (in addition to structured `log.info`):

```
[manipulation] daily scan started
[manipulation] daily scan complete { scanned, snapshotsPersisted, failed, durationMs }
[manipulation] daily scan failed { error | reason, warnings }
```

## Structured logs (signal jobs)

Every signal job emits greppable `[DAILY_JOB]` lines at start and complete:

```json
{
  "event": "complete",
  "job_name": "evening-scan",
  "mode": "scan",
  "data_source": "db",
  "start_time": "2026-06-22T11:00:00.000Z",
  "end_time": "2026-06-22T11:12:34.000Z",
  "duration_ms": 754000,
  "total_symbols": 504,
  "scanned_symbols": 169,
  "requests_used": 0,
  "signals_generated": 12,
  "failed_symbols": 335,
  "ok": true
}
```

| Field | Scan jobs | Evening update |
|-------|-----------|----------------|
| `scanned_symbols` | Symbols with sufficient candles | Symbols fetched from IndianAPI |
| `requests_used` | Always 0 (DB-only) | IndianAPI request count |
| `signals_generated` | Phase 4 signal count | 0 |
| `failed_symbols` | Insufficient-candle skips | Provider fetch failures |

## Environment overrides

```bash
MORNING_SCAN_CRON="30 8 * * 1-5"
EVENING_UPDATE_CRON="0 16 * * 1-5"    # alias: CANDLE_DAILY_UPDATE_CRON
EVENING_SCAN_CRON="30 16 * * 1-5"
MANIPULATION_DAILY_SCAN_CRON="30 18 * * 1-5"
DAILY_SCAN_SCHEDULE_ENABLED=true
CANDLE_DAILY_UPDATE_MAX_FETCH=1000

# Optional legacy duplicate scan at 18:30 IST (off by default)
SIGNAL_LEGACY_EVENING_SCAN_1830=false
SIGNAL_LEGACY_EVENING_SCAN_CRON="30 18 * * 1-5"
```

## Manual triggers

```bash
npx tsx scripts/runDailyScanJob.ts morning-scan
npx tsx scripts/runDailyScanJob.ts evening-update
npx tsx scripts/runDailyScanJob.ts evening-scan
npm run manipulation-scan   # ad-hoc; loads universe + scan (no scheduler)
```

## API equivalents

| Scheduled job | Manual API |
|---------------|------------|
| Morning / Evening Scan | `POST /api/run-signal-engine?mode=scan&sync=true` |
| Evening Update | `POST /api/run-signal-engine?mode=backfill&sync=true` or `npm run candles:daily` |
| Manipulation Scan (full pipeline) | `POST /api/manipulation/daily-scan` |
| Manipulation Scan (scan-only) | `POST /api/manipulation/daily-scan` body `{ "skipIngestion": true }` |

## Generation sources (audit)

| Job | `generation_source` |
|-----|---------------------|
| Morning Scan | `cron:morning-scan` |
| Evening Scan | `cron:evening-scan` |
| Legacy 18:30 | `cron:signal-generation` |
| Manipulation Scan | (snapshots in `q365_manipulation_snapshots`; no Phase 4 source tag) |

## Related jobs (outside dailyScanSchedule)

- **09:25 IST** — pre-open candle warmup (`refreshDailyCandles`, market scheduler)
- **10-min intraday** — lightweight DB scan during session (`runSignalGeneration` in worker scheduler)
- **19:00 IST** — nightly backtest
- **19:30 IST** — separate `scheduler.ts` cron runs `runDailyManipulationScan()` **with** EOD ingestion (NSE bhavcopy path). This is independent of the 18:30 scan-only job above; operators should not enable both ingestion paths for the same trade date without intent.
