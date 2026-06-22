# IndianAPI Request Policy

Operational budget for historical candle ingestion and signal scans. Enforced in code via `src/lib/marketData/providerRequestPolicy.ts` and quota guards in `providerRequestLog.ts`.

## Initial backfill (run once)

| Item | Value |
|------|-------|
| When | One-time warehouse bootstrap |
| Expected requests | **1,000–1,500** (~1 req/symbol × NSE 1000 universe) |
| History | **1 year** daily candles per symbol (`1y` range) |
| Per-run cap | `INDIAN_API_INITIAL_BACKFILL_PER_RUN_LIMIT` (default **1500**) |

```bash
npm run candles:backfill:preflight
npm run candles:backfill:plan          # dry-run estimate
npx tsx scripts/backfillCandles.ts --max-fetch 1500   # one-shot initial load
```

Do **not** schedule full 1y backfill on a cron. After bootstrap, only repair thin/stale symbols.

## Daily operations

| Job | Time (IST) | Mode | IndianAPI requests |
|-----|------------|------|-------------------|
| Morning scan | 08:30 | `scan` | **0** (DB-only) |
| Evening update | 16:00 | `incremental-update` | **≤ 1,000** |
| Evening scan | 16:30 | `scan` | **0** (DB-only) |

Evening update fetches only symbols missing the latest completed trading day. Thin symbols may use `1y`; healthy symbols use `1mo` incremental.

```bash
npm run candles:daily:plan
npm run candles:daily
npm run scans:evening-update
```

Cap env: `CANDLE_DAILY_UPDATE_MAX_FETCH=1000` (default).

## Monthly planning

| Band | Requests |
|------|----------|
| Planned ops | **22,000–30,000** / month |
| Soft target (`INDIANAPI_MONTHLY_TARGET`) | **25,000** (default) |
| Hard ceiling (`INDIANAPI_MONTHLY_LIMIT`) | **100,000** (paid plan) |

Reserve headroom above 30k for retries, repairs, testing, and future modules. Compliance label (`SAFE` / `BORDERLINE` / `UNSAFE`) uses the 25k target; hard stop uses the 100k ceiling.

## Emergency repair

Only fetch **failed / missing / stale** symbols — never rerun full 1y backfill daily.

```bash
npm run candles:repair              # resume batch, max 50 symbols
npm run candles:backfill:batch        # same as repair
npx tsx scripts/backfillCandles.ts --symbol RELIANCE --resume
```

Uses `resume: true` + `loadSymbolsNeedingBackfill()` so symbols with sufficient fresh history are skipped (zero API).

## Avoid

- Full 1-year backfill twice daily
- Fetching candles inside strategy evaluation (`dbOnly` / `evaluationRead` in `candleFallbackChain`)
- Fetching historical data during every signal scan (`mode=scan` skips `refreshDailyCandles`)
- Retrying failed provider requests too aggressively (backoff: `CANDLE_BACKFILL_RATE_LIMIT_BACKOFF_MS`, default 15s)
- Using IndianAPI when DB already has fresh candle data (`shouldSkipSymbol`, daily update skip-if-updated)

## Validation

```bash
npm run validate:provider-request-policy
npm run quota:audit
npm run quota:audit -- --estimate-daily-update
```

## Related

- [Daily scan schedule](./DAILY_SCAN_SCHEDULE.md)
- `src/lib/marketData/candleBackfillJob.ts` — initial + repair backfill
- `src/lib/marketData/candleDailyUpdateJob.ts` — evening incremental update
- `src/lib/workers/dailyScanSchedule.ts` — cron wiring
