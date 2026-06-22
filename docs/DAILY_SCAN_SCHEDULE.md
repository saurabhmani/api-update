# Daily Scan Schedule (IST)

Three scheduled jobs run on weekdays when `DAILY_SCAN_SCHEDULE_ENABLED=true` (default). Registered by `startDailyScanSchedule()` from the worker process (`npm run scheduler`).

## Schedule

| Job | Window | Cron (default) | Mode | Data source | IndianAPI historical |
|-----|--------|----------------|------|-------------|----------------------|
| **Morning Scan** | 08:30–09:00 | `30 8 * * 1-5` | `scan` | `market_data_daily` (DB) | **0** |
| **Evening Update** | 16:00 | `0 16 * * 1-5` | `incremental-update` | IndianAPI | ~1 req/symbol behind target day |
| **Evening Scan** | 16:30–17:00 | `30 16 * * 1-5` | `scan` | `market_data_daily` (DB) | **0** |

### Purpose

- **Morning Scan** — pre-market signals from the last completed daily candle (previous session close).
- **Evening Update** — fetch the latest completed EOD bar for the NSE 1000 universe (`runCandleDailyUpdateJob`).
- **Evening Scan** — fresh EOD signals after the evening candle update lands in DB.

## Structured logs

Every job emits greppable `[DAILY_JOB]` lines at start and complete:

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
DAILY_SCAN_SCHEDULE_ENABLED=true

# Optional legacy duplicate scan at 18:30 IST (off by default)
SIGNAL_LEGACY_EVENING_SCAN_1830=false
SIGNAL_LEGACY_EVENING_SCAN_CRON="30 18 * * 1-5"
```

## Manual triggers

```bash
npx tsx scripts/runDailyScanJob.ts morning-scan
npx tsx scripts/runDailyScanJob.ts evening-update
npx tsx scripts/runDailyScanJob.ts evening-scan
```

## API equivalents

| Scheduled job | Manual API |
|---------------|------------|
| Morning / Evening Scan | `POST /api/run-signal-engine?mode=scan&sync=true` |
| Evening Update | `POST /api/run-signal-engine?mode=backfill&sync=true` or `npm run candles:daily` |

## Generation sources (audit)

| Job | `generation_source` |
|-----|---------------------|
| Morning Scan | `cron:morning-scan` |
| Evening Scan | `cron:evening-scan` |
| Legacy 18:30 | `cron:signal-generation` |

## Related jobs (unchanged)

- **09:25 IST** — pre-open candle warmup (`refreshDailyCandles`, market scheduler)
- **10-min intraday** — lightweight DB scan during session (`runSignalGeneration` in worker scheduler)
- **19:00 IST** — nightly backtest
