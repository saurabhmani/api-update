# Signals API measured performance report

Generated: 2026-07-31

## Measurement status

The production build completed successfully and the API was measured with an
authenticated database-backed session. One 100-request production scenario was
completed before the only unexpired session expired. The database contains zero
rows in `q365_signals`, `q365_confirmed_signal_snapshots`, and
`q365_signal_maturity_tracker`, so large-dataset and non-empty Redis-hit
measurements cannot be represented by this environment.

No synthetic latency values are reported.

## Root causes proven by runtime evidence

1. The original authenticated request returned HTTP 500 after 2,452 ms.
   `getActiveConfirmedSnapshots` selected the absent
   `q365_signals.composite_final_score` column. The tracker reader separately
   selected the absent `q365_signals.classification` column.
2. The development server introduced non-API stalls. A client request took
   90,183.92 ms while the server recorded 4,217 ms inside the route. Logs showed
   filesystem-cache compaction and background scanner/provider activity during
   the missing interval. Production benchmarking was therefore used.
3. The first successful route profile was dominated by one-time universe
   initialization, not ranking, filtering, serialization, Redis, or providers.

## First successful request stage ranking

Total route time: 4,217 ms. Percentages use that total and do not count
unprofiled framework time as a function.

| Function | Calls | Avg ms | Max ms | % total |
|---|---:|---:|---:|---:|
| `universe_validation` | 1 | 3,406 | 3,406 | 80.77% |
| `signal_source_selection` | 1 | 352 | 352 | 8.35% |
| `authentication` | 1 | 77 | 77 | 1.83% |
| `database_queries` | 1 | 75 | 75 | 1.78% |
| `market_data_stack` | 1 | 20 | 20 | 0.47% |
| `signal_processing_ranking_filtering` | 1 | 9 | 9 | 0.21% |
| `ranking_sorting_maturity` | 1 | 8 | 8 | 0.19% |
| `redis_rotation_lookup` | 1 | 4 | 4 | 0.09% |
| `redis_lookup` | 1 | 2 | 2 | 0.05% |
| `response_serialization` | 1 | 2 | 2 | 0.05% |
| `market_status_detection` | 1 | 1 | 1 | 0.02% |
| `market_data_fetch` | 1 | 1 | 1 | 0.02% |

Confidence scoring, pagination, and request validation each measured below 1 ms.
No provider duration was attributed to the completed route.

## Production benchmark

Five warm-up requests were discarded before the measured set.

| Scenario | Requests | Average | Min | Max | P50 | P95 | P99 | Target |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Repeated small, limit 20 | 100 | 43.84 ms | 20.03 ms | 101.04 ms | 41.41 ms | 66.62 ms | 93.05 ms | Pass `<300 ms` |
| Cold cache | Not run | — | — | — | — | — | — | Session expired |
| Market open | Not run | — | — | — | — | — | — | Session expired |
| Market closed | Not run | — | — | — | — | — | — | Requires closed-session fixture/runtime |
| Large dataset | Not run | — | — | — | — | — | — | Source tables contain zero rows |

The initial production request after startup took 2,435.80 ms. It includes cold
process and universe initialization and does not meet the uncached target.

## Database evidence

| Query | Actual ms | Rows returned | Access/index | Scan |
|---|---:|---:|---|---|
| Active confirmed snapshots | 2.564 | 0 | `range`, `idx_csnap_status_validity`; joined tables `eq_ref` | No full scan |
| In-progress trackers | 2.105 | 0 | Tracker `ALL`; signal join `PRIMARY` | Full scan estimate 1 row |
| Snapshot read metadata | 1.117 | 1 | Min/max optimization, no matching row | No material scan |
| Tracker counts | 1.245 | 0 | `idx_smt_stage` | Index scan |

The current empty tables cannot prove the benefit of a new tracker composite
index. No index migration was added on zero-cardinality evidence.

`user_sessions.token` already has a unique index and also has a redundant
`idx_sessions_token` index. Removing the duplicate is recommended through the
canonical MySQL migration mechanism after checking other environments.

## Redis evidence

- Redis connection: successful.
- PING: 2.072 ms.
- `REDIS_DISABLED`: false.
- Signals response keys after the benchmark: zero.
- Hit rate for non-empty Signals response cache: not measurable.
- Cause: the database returned zero signals and the route intentionally does
  not cache empty live results.
- The Redis-to-memory warm path previously lost the Redis TTL and made the
  in-process copy non-expiring. It now reads `GET` and `PTTL` together and
  preserves the remaining expiry.
- Cache writes now serialize once and reuse the serialized value for memory and
  Redis.

## External dependencies and frontend

The successful route recorded `market_data_fetch=1 ms` and zero provider
duration. Background scheduler provider activity was visible in development
logs, but was not part of the completed production route.

The Signals page performs one guarded initial HTTP request and then relies on
SSE/WebSocket updates. There is no focus refetch or recurring HTTP polling.

## Remaining blockers

Acceptance is not fully proven because:

1. no authenticated session remains;
2. signal, snapshot, and tracker tables are empty;
3. a market-closed runtime or deterministic read-only market-state fixture is
   unavailable;
4. cold production startup remains above 800 ms due primarily to one-time
   universe initialization.

The benchmark can resume with:

```text
npm run benchmark:signals-api -- --requests=100 --warmups=5
```

after an authenticated login and representative non-empty signal data are
available.
