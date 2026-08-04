# Backtest processor parity report

- Fixture version: `fixture-v1`
- Strategy contract: recorded from `STRATEGY_ENGINE_VERSION.contractVersion`
- Input version: persisted on claim
- Status: integration harness ready; full persisted business-result fixture pending

The monolith and worker call the identical `processBacktestClaim`, `runBacktest`, Strategy Engine facade, Market Data facade, and persistence orchestration. A complete parity gate must compare status, summaries, ordered trades, dates, prices, fees, slippage, P&L, equity, drawdown, calibration, strategy breakdowns, and all result tables. Only processing timestamps, processor identity, worker instance, and internal correlation IDs may be normalized. Staging enablement remains blocked until this fixture runs with approved deterministic historical market data.
# Persisted-result parity status

Fixture `q365-backtest-canary-nse-v1` v1.0.0 and a strict persisted-table comparator are implemented. Only operational identity and timing fields are normalized. Comparator unit tests prove operational differences normalize and business differences fail.

The actual isolated monolith and worker persisted runs have **not yet executed**. `artifacts/backtest-parity-report.json` therefore has verdict `not-executed`; this is a staging blocker, not a pass.

Execution preflight on 2026-08-03 found that the versioned fixture is not runnable for its documented characteristics: `FIXTURE-A` contains 3 candles and `FIXTURE-B` contains 2, while the real engine requires at least 100 bars for warmup and indicator evaluation. The fixture hash is internally consistent, but an accepted candidate, rejected candidate, and opened/closed trade cannot be produced from it. No comparator-only or failed-run parity result is accepted as business parity.
# 2026-08-04 fixture-v2 evidence update

Fixture `q365-backtest-canary-synthetic-v2` contains 280 deterministic weekday bars for `FIXTURE-A`, `FIXTURE-B`, and `FIXTURE-BENCH`. Its static integrity, schema, hash, 220-bar warmup plus 40-bar safety margin, and production signal-pipeline gates pass. The production pipeline produces one accepted `FIXTURE-A` candidate and one liquidity rejection for `FIXTURE-B`.

Persisted parity remains **not-executed**. The Linux/MySQL 8.4 full-schema initializer did not reach migration 017 and candle loading within its five-minute bound, so the process harness produced no real run IDs. Static fixture suitability is not persisted business-result evidence.
# 2026-08-04 executable parity result

Real Linux monolith and worker executions completed against disposable MySQL 8.4.11. Both persisted 3 trades, 3 signals, 3 outcomes, 30 metrics, 15 calibration rows, 59 equity points, one performance row, one news-analytics row, and one summary row. All eleven tables matched after removing only surrogate IDs, run-derived references, processor ownership metadata, and runtime performance/timing metadata. Business dates, prices, quantities, fees, slippage, P&L, classifications, progress, strategy output, and versions were not normalized. Verdict: **passed**, zero mismatches.
# 2026-08-04 executable parity result

Real Linux monolith and worker executions completed against disposable MySQL 8.4.11. Both persisted 3 trades, 3 signals, 3 outcomes, 30 metrics, 15 calibration rows, 59 equity points, one performance row, one news-analytics row, and one summary row. All eleven tables matched after removing only surrogate IDs, run-derived references, processor ownership metadata, and runtime performance/timing metadata. Business dates, prices, quantities, fees, slippage, P&L, classifications, progress, strategy output, and versions were not normalized. Verdict: **passed**, zero mismatches.
