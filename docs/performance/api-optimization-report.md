# API Optimization Final Report

## Delivered scope

- Audited 332 API route files and created Markdown and JSON inventories.
- Added a centralized, reusable Redis cache layer without adding another
  client.
- Added explicit TTL and route cache classification catalogues.
- Optimized the first high-impact batch: dashboard, rankings, ticker, Trade
  Setup and related invalidation write paths.
- Added canonical MySQL indexes selected from actual query patterns.
- Optimized React Query/page request behavior.
- Added request, database, Redis, provider, cache and Trade Setup metrics.
- Added focused cache, API, page, authorization, resolver and concurrency
  tests.

## Redis architecture

The single client remains in `src/lib/redis.ts`. `src/lib/cache` provides
versioned keys, opaque user scopes, policies, classification, cache-aside/SWR,
coalescing and precise invalidation. Redis failure degrades to in-process
memory and/or the route's MySQL/provider loader.

## Optimized APIs

| API | Optimization |
|---|---|
| `/api/dashboard` | User cache, parallel I/O, preserved session behavior |
| `/api/rankings` | Validation, pagination, parallel independent queries, safe errors |
| `/api/ticker` | Short centralized cache and hit short-circuit |
| `/api/trade-setups` | Ownership, deterministic identity, cache, lock, resolver, timeouts and safe errors |
| Related signal/ranking/portfolio/paper/strategy/news/user writes | Targeted invalidation |

## Database indexes

- `idx_sessions_user_expires`
- `idx_pp_portfolio_added`
- `idx_ts_user_status_created`
- `idx_news_published_category_date`
- `idx_paper_orders_account_created`

See `database-index-optimization.md` for rollback SQL and the unexecuted staging
`EXPLAIN` commands. The local database session could not be established for
plans because the Node process reported `uv_os_get_passwd ENOMEM`; no plan
success is claimed.

## Trade Setup change

Previously the page depended on manual generation. It now loads automatically,
waits for authentication and all inputs, avoids rerender/Strict Mode duplicate
requests, reuses fresh data, supports retry and manual force regeneration, and
uses layered server deduplication. Market data always comes through the
existing resolver.

## Duplicate prevention

- React `useRef` identity guard.
- React Query request deduplication for reads.
- Deterministic server identity.
- Recent database-result lookup.
- Unique database generation identity and idempotent upsert.
- In-process promise map.
- Short Redis distributed lock with ownership-safe release.

## Validation status

Executed on 2026-07-30:

| Command | Result |
|---|---|
| Focused Vitest command covering cache, handlers, Trade Setup, auth and resolver | Passed: 12 files, 115 tests |
| `npm run test:signals-gate` | Passed: 9 files, 122 tests |
| `npm run test:operations` | Passed: 1 file, 2 tests |
| `npm run test:monitoring` | Passed: 1 file, 3 tests |
| `npm run test:deployment-validation` | Passed: 1 file, 3 tests |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed; 78 static pages generated |
| `npm run test:contracts` | Failed: 36 of 85 tests |

The contracts failures are pre-existing/unrelated to the performance batch:
28 stale dashboard UI source-contract assertions, 4 top-losers source-contract
assertions, and 4 daily-report market-mover tests that require configured
market-mover data. The CI workflow marks this contracts job non-blocking. No
production code was changed merely to satisfy those unrelated expectations.

The successful build emitted non-fatal optional native-addon warnings for
`bufferutil` and `utf-8-validate` from `kiteconnect`'s nested `ws` dependency.

## Remaining risks

- Most of the 332 audited routes remain intentionally unmodified; subsequent
  batches should start from the P0/P1 inventory.
- Redis locks are process-local only during Redis outages, so cross-replica
  deduplication temporarily degrades.
- Process-local Prometheus counters reset on restart and require scrape-time
  aggregation across replicas.
- Several legacy cache key formats remain until their owning routes migrate.
- Live staging `EXPLAIN` evidence is still required before assessing actual
  cardinality and filesort behavior.
- Response size cannot be measured safely for every streaming `NextResponse`.

## Recommended next phase

Optimize the next P0/P1 read batch from the inventory, prioritizing signals,
market-data aggregation and other dashboard dependencies. Capture staging slow
query logs and `EXPLAIN ANALYZE`, establish latency/cache-hit SLO dashboards,
then migrate remaining legacy cache keys only alongside tested mutation
invalidation.
