# Production engine reliability audit — 2026-08

## Architecture discovered

The production runtime is a Next.js TypeScript monolith plus a separately deployed
`src/lib/workers/scheduler.ts` process (PM2/node-cron). MySQL is the current query
dialect; PostgreSQL migrations exist for the staged cutover. Redis provides cache
and distributed locks in selected ingestion/bootstrap paths.

| Area | HTTP/API and service entry points | Persistent sources | Automatic work before this change |
|---|---|---|---|
| Market/candles | `api/market*`, `api/market-data*`, `api/data-feed/health`; `marketData`, `eod`, `candle*` modules | `candles`, provider request logs, Redis quote/tick keys | Intraday scheduler, 16:00 update, 19:30 bhavcopy path; overlapping ownership |
| Universe/stocks | `api/stocks*`, scanner custom-universe APIs; `ensureUniverseReady`, weekly universe rebuild | `q365_universe`, `securities_master`, universe snapshots | Weekly Sunday rebuild plus request/startup readiness paths |
| Signal/scanner | `api/signals`, `api/signal-engine`, `api/run-signal-engine`, scanner routes; Phase 1–4 services | `q365_signals`, confirmed snapshots, lifecycle/rejection/reason tables | Timed scans/rescores; optional GET-triggered recovery remained |
| Risk geometry | signal engine trade-plan/risk modules, portfolio risk APIs | geometry columns on `q365_signals`, risk snapshot/trade-plan tables | Generated on some creation paths; no authoritative repair stage |
| Manipulation | `api/manipulation*`, `api/manipulation-engine*`; `runDailyManipulationScan` | snapshots, events, penalties, watchlists, calibration | 18:30 scan-only and 19:30 ingest+scan; local overlap guards |
| Scoring/confirmation | `api/signals/confirmation`, rescore services, confirmation aggregator | signal score/band columns and confirmation snapshots | 12:30/14:45 rescores, not tied to EOD completion |
| Backtesting/evaluation | `api/backtest*`, `api/backtests*`, `api/signals/backtest`; backtest runner and daily engine | backtest runs/trades/outcomes/calibration | 19:00 full run and queue drain; daily persistence worker was proposal-only |
| Learning/review | strategy learning/calibration APIs; `learningScheduler`, review engine | signal outcomes, observations, calibration/performance snapshots, learning job runs | executable worker and outcome evaluation, but not one durable same-date DAG |
| Daily report | `api/signals/daily-report`, report builder | no active report table/writer before this change | computed during GET; scheduled writer was proposal-only |
| Health/operations | signals engine-health, data-feed health, operations/reliability/admin health | direct aggregate probes, cache state, cron logs | mixed direct probes and nested HTTP; signal health still called `/api/signals` |

External providers are IndianAPI adapters, NSE direct/bhavcopy sources, Yahoo
fallback/history, broker streams, and configured news providers. Expensive work is
Phase 1–4 generation, universe-wide candle fetch/backfill, manipulation scans,
full backtests, outcome evaluation, learning aggregation, and report assembly.

## Root causes

- Manipulation freshness: two independently timed paths, scan-only execution did
  not prove current-date candle/signal readiness, clean coverage could not be
  distinguished from omitted work, locks were process-local, and missed dates had
  no durable recovery ledger.
- Risk geometry: generation/enrichment/persistence paths are split. Active records
  can be persisted before all geometry is durable and no post-signal invariant
  repair existed. Truthful health then reports IRR/RR with zero stop/target rows.
- Daily report insufficiency: reports were assembled on GET, the persistence job
  and table were proposal-only, and no prerequisite barrier prevented early runs.
- Backtest insufficiency: strategies need 200–220 warmup bars. A bounded backfill
  exists but was not a prerequisite of daily evaluation; interactive paths could
  therefore repeatedly encounter the same missing history.
- Learning insufficiency: observations require matured/closed signals and fresh
  outcomes. The learning worker was independent of outcome completion and its job
  table could not represent trading-date bootstrap versus failure.
- Health timeouts: engine-health still nested into the heavy `/api/signals` response
  assembly with a 30-second allowance. Other probes were concurrent and bounded.
- Duplicate work: separate cron clocks, request-time recovery, and process-local
  booleans/maps do not coalesce work across multiple application instances.

## Scheduler and dependency graph

Previous schedules were weekday cron in Asia/Kolkata: intraday candle refresh,
08:30 readiness, 09:20/09:45 scans, 12:30/14:45 rescores, 16:00 EOD update, 16:30
scan, 18:30 manipulation, 19:00 backtest, 19:30 alternate EOD+manipulation, and
20:00 outcome evaluation. The market helper centralizes IST and a holiday list,
but cron itself only excludes weekends. Restart/missed-run repair was inconsistent.

The durable post-close order is now:

1. market data ingestion
2. same-date coverage validation
3. universe readiness
4. signal generation
5. risk geometry repair and invariant validation
6. manipulation scan and full coverage validation
7. scoring/confirmation
8. bounded 220-bar history backfill
9. incremental outcome/backtest evaluation
10. learning/review
11. one persisted daily report
12. final health snapshot

Any non-succeeded prerequisite is recorded and blocks downstream stages. The
20:30 IST scheduler invocation processes at most two missing dates per run.

## Schema and indexes

`q365_maintenance_job_runs` is additive and records run/stage/date/version,
status, timestamps/heartbeat, counts, retries, errors, dependency run IDs and
metadata. Its unique `(job_name,trading_date,job_version)` key is both the
idempotency key and cross-instance claim. `(trading_date,status)` supports missed
date and date-health queries; `(status,heartbeat_at)` supports stale-claim repair;
`run_id` supports trace lookup.

`q365_daily_signal_reports` is activated with a unique report-date key for
idempotent upsert and `(report_status,report_date)` for operator/history filters.
Existing manipulation `(symbol,snapshot_date)` uniqueness already supports clean
coverage. No speculative signal/candle indexes were added: their deployed schema
must be checked with `EXPLAIN` before changing high-write tables.

## Files and repair

The implementation is in `src/lib/maintenance/*`, scheduler wiring in
`src/lib/workers/scheduler.ts`, direct engine-health wiring in the signals health
route, schema bootstrap in `ensureAllSchemas.ts`, and migrations 016/033. Existing
active geometry is repaired in bounded batches only when one valid side allows the
missing side to be derived at the existing 2R convention; non-derivable rows remain
failed and visible. Candle backfill is capped at 50 provider fetches per stage and
resumes. Missed reports and all later stages are recovered oldest-first, two dates
per scheduled invocation.

## Risks

- Applying schema while old workers run is safe/additive, but deploy migration
  before enabling the new scheduler.
- Provider holidays/delays produce a truthful failed market-data stage and retry;
  they are not marked complete.
- The bounded history stage may need several days for a large new universe.
- Legacy intraday schedules remain for market operation; the durable ledger is the
  authority for EOD completion. Operators should disable redundant legacy EOD
  manipulation/backtest clocks after validating the new DAG in production.
- PostgreSQL uses its native migration; the runtime repository currently follows
  the application's MySQL query dialect and must move with the planned DB cutover.
