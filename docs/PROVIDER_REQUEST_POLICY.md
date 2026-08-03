# Provider Request Policy

Operational budget guidance for market-data ingestion.

**Provider selection:** `MARKET_DATA_PROVIDER` picks the system warehouse provider
(`indianapi` | `kite` | `yahoo` | `none`). When it is **unset** and
`INDIANAPI_ENABLED=true` with `INDIANAPI_API_KEY` present, the system
bootstraps **IndianAPI** as the default provider. In IndianAPI mode the
serve path is **cache → DB only** — clients never trigger upstream HTTP;
the ingestion orchestrator (`src/lib/marketData/ingestion/`) is the sole
IndianAPI caller.

Budgets are enforced in code via:

- `src/providers/adapters/indianApiUsageTracker.ts` — Redis-backed daily /
  monthly / per-run counters (IndianAPI)
- `src/lib/marketData/providers/indianApiRateLimiter.ts` — global RPS +
  concurrency (IndianAPI)
- `src/lib/marketData/providerRequestPolicy.ts` + quota guards in
  `providerRequestLog.ts` — candle job caps (all providers)

Every upstream call is audited in `provider_request_logs`
(`provider='indianapi'` / `'kite'`), and IndianAPI run summaries land in
`indianapi_ingestion_runs`.

## IndianAPI ingestion budgets

| Knob | Env | Default |
|------|-----|---------|
| Global RPS | `INDIANAPI_RPS_GLOBAL` | 2 |
| Concurrency | `INDIANAPI_MAX_CONCURRENCY` | 3 |
| Per-run cap | `INDIANAPI_PER_RUN_LIMIT` | 1,500 |
| Daily soft limit (degrade) | `INDIANAPI_DAILY_SOFT_LIMIT` | 4,500 |
| Monthly hard limit (freeze) | `INDIANAPI_MONTHLY_LIMIT` | 100,000 |
| Batch mode | `INDIANAPI_BATCH_ENABLED` | `auto` (probed; 404 → per-symbol) |
| Batch size | `INDIANAPI_BATCH_SIZE` | 25 |

### Cost model (active universe ≈ 1,000 symbols)

| Tier | Cadence | Cost per run |
|------|---------|--------------|
| Quotes (batch mode) | every 10 min market hours | ~40 calls (1000 / 25) |
| Quotes (per-symbol) | every 10 min market hours | up to 1,000 calls — bounded by per-run cap; expect throttled waves |
| Movers / discovery | every 10–15 min market hours | ~2 calls |
| EOD candles | 16:00 IST daily | ≤ 1,000 (`CANDLE_DAILY_UPDATE_MAX_FETCH`) |
| Profile rotation | Sunday 06:30 IST | ≤ 200 |
| Repair (dead letters) | 17:30 IST weekdays | ≤ 50–100 |

When the batch endpoint is unavailable on the subscribed plan, reduce the
quote cadence or set `INDIANAPI_INGEST_SYMBOL_LIMIT` so the 10-minute tier
fits the RPS/daily budget. 429s pause the entire queue (`Retry-After`
honored) — retries are a bounded secondary net, never the rate limiter.

## Initial backfill (run once)

| Item | Value |
|------|-------|
| When | One-time warehouse bootstrap |
| Expected requests | **1,000–1,500** (~1 req/symbol × NSE 1000 universe) |
| History | **1 year** daily candles per symbol (`1y` range) |
| Per-run cap | `INDIANAPI_PER_RUN_LIMIT` / candle per-run cap (default **1500**) |

```bash
npm run candles:backfill:preflight
npm run candles:backfill:plan          # dry-run estimate
npx tsx scripts/backfillCandles.ts --max-fetch 1500   # one-shot initial load
```

Do **not** schedule full 1y backfill on a cron. After bootstrap, only repair
thin/stale symbols. Note: IndianAPI `/historical_data` is a close-only
series (OHLC collapse to close, volume 0) with warehouse source precedence
below bhavcopy/Kite — real OHLCV is never overwritten.

## Daily operations

| Job | Time (IST) | Mode | Upstream requests |
|-----|------------|------|-------------------|
| Morning scan | 08:30 | `scan` | **0** (DB-only) |
| Evening update | 16:00 | `incremental-update` | **≤ 1,000** |
| Evening scan | 16:30 | `scan` | **0** (DB-only) |

Evening update fetches only symbols missing the latest completed trading
day. Thin symbols may use `1y`; healthy symbols use `1mo` incremental.

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
| Daily soft limit (`INDIANAPI_DAILY_SOFT_LIMIT`) | **4,500** / day (default) |
| Hard ceiling (`INDIANAPI_MONTHLY_LIMIT`) | **100,000** / month |

Reserve headroom above 30k for retries, repairs, testing, and future
modules. Daily soft limit degrades (ingestion resumes next day); monthly
limit freezes all IndianAPI calls until the month rolls.

## Emergency repair

Only fetch **failed / missing / stale** symbols — never rerun full 1y
backfill daily. Failed symbols accumulate in
`indianapi_symbol_sync_state` (`consecutive_failures > 0`) and are drained
by `runRepairIngestion` (17:30 IST cron, capped).

```bash
npm run candles:repair              # resume batch, max 50 symbols
npm run candles:backfill:batch      # same as repair
npx tsx scripts/backfillCandles.ts --symbol RELIANCE --resume
```

## Observability

- `[INDIANAPI_INGEST]` structured log lines per run (tier, processed,
  failed, rate_limited, api_calls, aborted).
- Prometheus: `institutional_indianapi_requests_total`,
  `..._rate_limited_total`, `..._circuit_opens_total`,
  `..._overlap_skips_total`, `..._budget_blocks_total`,
  `..._ingestion_runs_total`, `..._quote_sync_age_seconds` (alert on lag).
- `provider_request_logs` aggregation:
  `aggregateProviderRequests('indianapi')`.

## Avoid

- Full 1-year backfill twice daily
- Fetching candles inside strategy evaluation (`dbOnly` / `evaluationRead` in `candleFallbackChain`)
- Fetching historical data during every signal scan (`mode=scan` skips `refreshDailyCandles`)
- Retrying failed provider requests too aggressively — retries are not a rate limiter
- Calling IndianAPI from any request path (architecture freeze test enforces ingestion-only imports)
- Re-fetching data the warehouse already has fresh (`shouldSkipSymbol`, daily update skip-if-updated)

## Validation

```bash
npm run validate:provider-request-policy
npm run quota:audit
npm run quota:audit -- --estimate-daily-update
```

## Related

- [Daily scan schedule](./DAILY_SCAN_SCHEDULE.md)
- `src/lib/marketData/ingestion/indianApiIngestionOrchestrator.ts` — IndianAPI ingestion tiers
- `src/lib/marketData/candleBackfillJob.ts` — initial + repair backfill
- `src/lib/marketData/candleDailyUpdateJob.ts` — evening incremental update
- `src/lib/workers/dailyScanSchedule.ts` — cron wiring
