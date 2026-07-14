# Daily Scan Schedule (IST)

Controlled weekday jobs when `DAILY_SCAN_SCHEDULE_ENABLED=true` (default). Registered by `startDailyScanSchedule()` from the worker process (`npm run scheduler`).

**removed vendor budget policy:** [PROVIDER_REQUEST_POLICY.md](./PROVIDER_REQUEST_POLICY.md)

## Schedule

| Job | Window | Cron (default) | Mode | Data source |
|-----|--------|----------------|------|-------------|
| **Readiness check** | 08:30 | `30 8 * * 1-5` | `readiness` | DB probes only — **no signals** |
| **First morning scan** | 09:20 | `20 9 * * 1-5` | `scan` | DB-only Phase 4 (first confirmation) |
| **Main morning scan** | 09:45 | `45 9 * * 1-5` | `scan` | DB-only Phase 4 (main morning) |
| **Midday rescore** | 12:30 | `30 12 * * 1-5` | `rescore` | Active signals only |
| **Late rescore** | 14:45 | `45 14 * * 1-5` | `rescore` | Active signal rescore / late confirmation |
| **Evening Update** | 16:00 | `0 16 * * 1-5` | `incremental-update` | removed vendor EOD |
| **Evening Scan** | 16:30 | `30 16 * * 1-5` | `scan` | DB-only Phase 4 (final EOD) |
| **Manipulation Scan** | 18:30 | `30 18 * * 1-5` | `scan-only` | `candles` warehouse |

Legacy **10-min Phase-4 regen**, **pre-open full-universe candle warmup**, and **poll-driven auto-recovery** are **off by default**:

```
PREOPEN_CANDLE_WARMUP_ENABLED=false
SIGNAL_INTRADAY_REGEN_ENABLED=false
SIGNALS_AUTO_RECOVERY_ENABLED=false
SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ=false
UNIVERSE_MODE=NSE1000
UNIVERSE_TARGET_SIZE=1000
UNIVERSE_ALLOW_BAND=false
```

### Purpose

- **Readiness check (08:30)** — universe size, `securities_master` EQ count, and candle coverage probes only. **Does not generate signals.**
- **First morning scan (09:20)** — DB-only Phase 4 confirmation scan from the last completed daily candle.
- **Main morning scan (09:45)** — DB-only Phase 4 main morning scan.
- **Midday / late rescore (12:30, 14:45)** — rescore active signals only; no full-universe scan.
- **Evening Update (16:00)** — fetch the latest completed EOD bar for the NSE 1000 universe (`runCandleDailyUpdateJob`). Populates the `candles` warehouse.
- **Evening Scan (16:30)** — DB-only Phase 4 final EOD scan after the 16:00 candle update.
- **Manipulation Scan (18:30)** — surveillance scan via `runDailyScan({ skipIngestion: true })`. Reads candles refreshed at 16:00; **does not** re-run EOD ingestion.

## Execution order (dependency graph)

```
08:30  Readiness check       (DB probes — no signals)
         │
09:20  First morning scan    (DB-only Phase 4)
         │
09:45  Main morning scan     (DB-only Phase 4)
         │
12:30  Midday rescore        (active signals only)
         │
14:45  Late rescore          (active signals only)
         │
16:00  Evening Update        ──► candles warehouse refreshed (removed vendor)
         │
16:30  Evening Scan          (DB-only Phase 4 on fresh EOD)
         │
         │  ← 2h slack for ~1,000-symbol fetch
         ▼
18:30  Manipulation Scan     runDailyScan({ skipIngestion: true })
                             └─ scan only; no duplicate ingestion
```

The manipulation job **depends** on the 16:00 Evening Update completing first. The 18:30 slot is deliberately 2h after EOD refresh to allow the removed vendor fetch to finish. If Evening Update overruns, manipulation still runs against the latest warehouse state (warning-only if candles are stale).

At schedule startup, `isManipulationScheduledAfterEodUpdate()` validates that configured cron expressions keep manipulation after 16:00 EOD update.

## Overlap / race guards

| Guard | Scope | Behaviour |
|-------|-------|-----------|
| `guardJob()` | Readiness / morning scans / rescore / evening update / evening scan | One in-flight run per job name; overlapping cron ticks return the existing promise |
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

| Field | Scan jobs | Rescore jobs | Evening update |
|-------|-----------|--------------|----------------|
| `scanned_symbols` | Symbols with sufficient candles | Active signals rescored | Symbols fetched from removed vendor |
| `requests_used` | Always 0 (DB-only) | Always 0 | removed vendor request count |
| `signals_generated` | Phase 4 signal count | Rescore updates | 0 |
| `failed_symbols` | Insufficient-candle skips | Rescore fetch failures | Provider fetch failures |

## Environment overrides

```bash
READINESS_CHECK_CRON="30 8 * * 1-5"
FIRST_MORNING_SCAN_CRON="20 9 * * 1-5"
MAIN_MORNING_SCAN_CRON="45 9 * * 1-5"
MIDDAY_RESCORE_CRON="30 12 * * 1-5"
LATE_RESCORE_CRON="45 14 * * 1-5"
EVENING_UPDATE_CRON="0 16 * * 1-5"    # alias: CANDLE_DAILY_UPDATE_CRON
EVENING_SCAN_CRON="30 16 * * 1-5"
MANIPULATION_DAILY_SCAN_CRON="30 18 * * 1-5"
DAILY_SCAN_SCHEDULE_ENABLED=true
CANDLE_DAILY_UPDATE_MAX_FETCH=1000

# Disabled by default — do not enable in prod without intent
PREOPEN_CANDLE_WARMUP_ENABLED=false
SIGNAL_INTRADAY_REGEN_ENABLED=false
SIGNALS_AUTO_RECOVERY_ENABLED=false
SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ=false
UNIVERSE_MODE=NSE1000
UNIVERSE_TARGET_SIZE=1000
UNIVERSE_ALLOW_BAND=false

# Optional legacy duplicate Phase-4 scan at 18:30 IST (off by default)
SIGNAL_LEGACY_EVENING_SCAN_1830=false
SIGNAL_LEGACY_EVENING_SCAN_CRON="30 18 * * 1-5"
```

## Manual triggers

```bash
npx tsx scripts/loadSecuritiesMaster.ts
npx tsx scripts/weeklyNse1000UniverseRebuild.ts --target 1000
npx tsx scripts/validateNse1000UniverseAcceptance.ts
npx tsx scripts/runDailyScanJob.ts readiness-check
npx tsx scripts/runDailyScanJob.ts first-morning-scan
npx tsx scripts/runDailyScanJob.ts main-morning-scan
npx tsx scripts/runDailyScanJob.ts midday-rescore
npx tsx scripts/runDailyScanJob.ts late-rescore
npx tsx scripts/runDailyScanJob.ts evening-update
npx tsx scripts/runDailyScanJob.ts evening-scan
npm run manipulation-scan   # ad-hoc; loads universe + scan (no scheduler)
```

Legacy alias: `morning-scan` → `first-morning-scan`.

## API equivalents

| Scheduled job | Manual API |
|---------------|------------|
| First / main / evening scan | `POST /api/run-signal-engine?mode=scan&sync=true` |
| Evening Update | `POST /api/run-signal-engine?mode=backfill&sync=true` or `npm run candles:daily` |
| Manipulation Scan (full pipeline) | `POST /api/manipulation/daily-scan` |
| Manipulation Scan (scan-only) | `POST /api/manipulation/daily-scan` body `{ "skipIngestion": true }` |

## Generation sources (audit)

| Job | `generation_source` |
|-----|---------------------|
| Readiness check | `cron:readiness-check` |
| First morning scan | `cron:first-morning-scan` |
| Main morning scan | `cron:main-morning-scan` |
| Midday rescore | `cron:midday-rescore` |
| Late rescore | `cron:late-rescore` |
| Evening Scan | `cron:evening-scan` |
| Legacy 18:30 Phase-4 | `cron:signal-generation` |
| Manipulation Scan | (snapshots in `q365_manipulation_snapshots`; no Phase 4 source tag) |

## Related jobs (outside dailyScanSchedule)

- **09:20 IST** — market-data batch warmup (`runBatchTier`, market scheduler)
- **09:25 IST** — pre-open candle warmup (`refreshDailyCandles`) — **disabled by default** (`PREOPEN_CANDLE_WARMUP_ENABLED=false`)
- **09:30–15:30 IST @ 10m** — market-data batch quotes (not Phase 4 signal scans)
- **19:00 IST** — nightly backtest
- **19:30 IST** — separate `scheduler.ts` cron runs `runDailyManipulationScan()` **with** EOD ingestion (NSE bhavcopy path). Independent of the 18:30 scan-only job; do not enable both ingestion paths for the same trade date without intent.
