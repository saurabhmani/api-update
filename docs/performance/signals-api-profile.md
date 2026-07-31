# GET /api/signals performance profile

## Scope and execution paths

The route is implemented by `src/app/api/signals/route.ts` and is wrapped by
`withApiHandler`. Authentication is mandatory. The main dashboard path is
`action=top` or `action=all`; the same handler also contains the lower-frequency
`stats`, `instrument`, `breakdowns`, and `history` branches.

The profiled main path is:

1. request start and request-ID assignment
2. authentication
3. query-string validation and source selection
4. market-data stack and universe validation
5. market-session detection
6. centralized Redis response lookup
7. database reads on a miss
8. broker/resolver market-data enrichment
9. strict approval, maturity, confidence, ranking, and filtering
10. pagination/capping
11. Redis store
12. response serialization and send

Every request emits the structured `q365_signals_api_profile` log with the
route, method, request ID, status, total duration, per-step durations, database
duration/query count/rows returned, Redis duration, provider duration and call
count, cache result, and serialized payload bytes. `rowsScanned` is deliberately
reported as `null`: the MySQL client exposes returned rows, not rows examined.
Rows examined must be obtained from `EXPLAIN ANALYZE` in a safe staging or
read-replica session.

## Branch inventory

| Branch | Principal work | Cache policy |
|---|---|---|
| `top`, `all` during market hours | confirmed snapshots, maturity trackers, metadata, optional live enrichment, ranking and response mapping | user- and market-session-scoped Redis, 30 seconds |
| `top`, `all` while closed | market-close snapshot and last completed session response | user- and trading-session-scoped Redis, 300 seconds |
| `stats`, `breakdowns`, `history` | historical/aggregate database reads | unchanged in this batch |
| `instrument` | instrument validation and live/provider revalidation; optional persistence behavior | not cached |

`bootstrap`, `noCache`, `debugSignals`, and forced-live operator requests bypass
the response cache. Empty live results are not cached, so a newly completed scan
is visible on the next request. Cached payloads exclude request-specific provider
metadata; that metadata and the current request ID are attached after the hit.

## Database query profile

On a normal live cache miss, the confirmed-signals service starts these
independent reads together:

- active confirmed snapshots (selected columns, qualification join, ordered and
  limited)
- in-progress maturity trackers (selected columns and latest signal join)
- maturity tracker grouped counts
- confirmed snapshot read metadata

The prior freshness and reader-diagnostics implementation issued six scalar or
grouped reads, including a duplicated active count. It is replaced by
`getConfirmedSnapshotReadMeta`, which executes two queries in parallel:

- one conditional aggregate for latest confirmation, lifetime count, active
  count, and reader-eligible count
- one grouped classification breakdown for active excluded rows

This changes the core bundle from nine database queries to six and removes the
duplicate active `COUNT(*)`. The four logical read groups are launched with
`Promise.all`. Snapshot and maturity enrichment are also independent and run
concurrently.

The main snapshot reader does not use `SELECT *`; it selects the fields required
by the response and policy layers. Its qualification data is joined once, and
the result is capped in SQL before application policy capping. No per-row
database query was found in the main `top`/`all` service, so there is no N+1 on
that path.

The closed-market branch currently performs a snapshot row read and a separate
snapshot metadata aggregate. Those reads are only reached after a cache miss.
They remain candidates for a later, isolated optimization because the response
construction has substantial legacy fallback behavior.

## Index review

Existing canonical MySQL schema ownership already defines:

- `q365_confirmed_signal_snapshots(status, valid_until)`
- `q365_confirmed_signal_snapshots(symbol, direction, status)`
- `q365_confirmed_signal_snapshots(source_signal_id)`
- `q365_confirmed_signal_snapshots(confirmed_at DESC)`
- `q365_confirmed_signal_snapshots(symbol)`

These cover the active/validity filter, source join, symbol lookup, and recent
confirmation access patterns. No index migration is added in this batch without
an actual execution plan. A likely candidate for the ordered active reader is:

```sql
CREATE INDEX idx_csnap_status_confirmed
  ON q365_confirmed_signal_snapshots (status, confirmed_at DESC);
```

It should only be added if `EXPLAIN ANALYZE` shows a filesort or excessive rows
examined after the `status = 'ACTIVE'` filter. Check first that production does
not already have an equivalent left-prefix index. Expected benefit is fewer
rows examined for recent active reads; cost is additional storage and write
maintenance on promotion/lifecycle updates. Rollback:

```sql
DROP INDEX idx_csnap_status_confirmed
  ON q365_confirmed_signal_snapshots;
```

No database connection or MySQL CLI was available in this workspace session, so
an execution plan was not fabricated. Run the reader and aggregate statements
with representative limits against a staging clone or read replica and attach
`EXPLAIN ANALYZE` output before accepting an index migration.

## Redis flow

The main path now follows cache-aside:

```text
authenticated request
  -> validate and resolve market session
  -> Redis GET
     -> HIT: attach request metadata and return
     -> MISS: parallel DB reads -> enrichment -> processing
              -> Redis SET -> return
```

Keys are produced by the centralized key builder and include the cache version,
environment, signals domain, an opaque hash of the user ID, action, limit,
response shape, and market-session context. Redis errors use the cache service's
graceful fallback and do not prevent MySQL/provider execution. Signal mutations
already invalidate the centralized `signals:*` namespace through precise pattern
invalidation; neither `FLUSHDB` nor `FLUSHALL` is used.

## Duplicate-work removals

- Request market status is resolved once and passed into the confirmed-signals
  service and both enrichment batches.
- Snapshot and tracker enrichment share that resolved market state.
- Freshness and reader diagnostics share one aggregate result.
- Active count is calculated once.
- Snapshot/tracker provider work runs concurrently.
- The old process-local freeze cache is no longer called by the GET path; this
  avoids its extra `MAX(generated_at)` database probe and unsafe global key.
- Ranking/filtering output is computed once and reused by response mapping.

## Operational interpretation

A cache hit should show `redis_lookup`, no `database_queries` or
`market_data_fetch` step, `cache=hit`, and zero database/provider work within
the handler context. A cache miss should show those steps plus `redis_store`.
Compare p50/p95 profiles by market state and action. Large `payloadSizeBytes`
or high returned-row-to-shipped-row ratios indicate the next optimization
target. Provider latency should be evaluated separately from database latency;
do not compensate for provider slowness by weakening authorization or serving
one user's cached live data to another user.
## Phase 5: market-data optimization

The confirmed-signals read path now combines snapshot and in-progress rows before
live-price enrichment. This produces one enrichment operation per API request
instead of two concurrent operations over separate arrays.

- Symbols are normalized and deduplicated before resolution.
- Broker quote lookup uses the provider batch API rather than a quote call inside
  a signal loop.
- The system fallback uses `marketDataResolver.resolveBatch`, which checks its
  Redis-backed quote cache before invoking providers and batches unresolved
  symbols.
- Both broker and resolver operations are protected by
  `SIGNALS_ENRICH_TIMEOUT_MS` (default 5 seconds).
- The combined result is split back into snapshot and in-progress collections
  without another provider request.

The route-level response cache remains the first data lookup for cacheable
`action=all` requests. During market hours its normal policy is 30 seconds; the
central cache policy extends the effective freshness when the market is closed.

## Phase 6: signal-processing optimization

The strict audit previously mapped all enriched rows, filtered and mapped passing
rows, and then filtered the audit output again for rejected rows. It now performs
one iteration that:

- evaluates each signal once;
- appends passing signals to the approved collection;
- appends rejected audit records to the dropped collection; and
- accumulates the rejection-cause histogram during the same pass.

The computed histogram is reused in diagnostics instead of being recalculated.
Profiling now records `confidence_scoring_filtering` and
`ranking_sorting_maturity` as separate stages. Ranking and maturity still execute
in their existing service boundaries to preserve ordering and response behavior.

## Phase 7: response optimization

The response contract was preserved because the current Signals UI consumes the
status, diagnostics, source metadata, approved aliases, counters, and timestamps.
Removing those fields would be a breaking change without a versioned endpoint.

Safe response work completed:

- the lite fallback representation is calculated once and reused for both
  `signals` and `approved`;
- response timestamps are formatted once and reused;
- no deep clone or JSON parse/stringify cycle is added before `NextResponse`;
- response byte size remains measured by the request profiler.

A future versioned compact endpoint can use field-usage telemetry to remove
legacy aliases without changing the current API contract.

## Phase 8: client request optimization

The page does not use React Query for this stream-backed data flow; it uses
`useSignalsPolling` plus SSE/WebSocket state updates. Converting the state machine
to React Query was intentionally avoided in this compatibility-focused pass.

Before this change, a normal mount could issue the initial request, a second
one-row stale probe, and recurring HTTP polling even while live transports were
active. It now:

- guards the initial load with a stable ref, including React Strict Mode mounts;
- makes exactly one automatic `GET /api/signals?action=all&limit=20`;
- relies on SSE/WebSocket messages for continuing live updates;
- performs no window-focus refetch;
- retains explicit manual refresh and recovery requests;
- aborts the active fetch during cleanup.

`keepPreviousData` is not applicable because this hook does not replace data
during a React Query pagination transition. The existing state remains visible
until the single load or a live update replaces it.

## Phase 9: parallelization

The closed-market branch previously awaited candle freshness, scanner-batch
metadata, universe size, maturity-tracker counts, and stored-signal loading one
after another. These reads have no data dependency and now run in one
`Promise.all`. Their error fallbacks and resulting response fields are unchanged.

Other awaits were retained where a real dependency exists, including session
authentication before user-scoped reads, market-session resolution before the
session-scoped cache key, cache lookup before database work, and synthetic batch
identity after scanner freshness resolution.

## Phase 10: slow-function detection

Every profiled request now emits a duration-descending `slowSteps` list. Steps
below 20 ms are excluded; each retained step is assigned its highest crossed
threshold: 20, 50, 100, 250, or 500 ms. The runtime report therefore identifies
the actual slow operation for each cold or warm request rather than assuming
Redis or database access is the bottleneck.

## Phase 11: Signals metrics and development headers

The existing metrics endpoint now exposes these process-cumulative Signals
series:

- `signals_request_ms`
- `signals_db_ms`
- `signals_cache_ms`
- `signals_provider_ms`
- `signals_processing_ms`
- `signals_payload_size`
- `signals_cache_hit`
- `signals_cache_miss`

Development responses additionally expose `X-Response-Time`, `X-Cache`,
`X-DB-Time`, and `X-Provider-Time`. These diagnostic headers are not added in
production, preserving the production wire contract.

## Phase 12: benchmark protocol

Runtime percentiles require a running application connected to representative
MySQL, Redis, provider, session, and market-state dependencies. For each
scenario, discard five warm-up requests and record at least 30 samples:

| Scenario | Cache | Market state | Dataset |
|---|---|---|---|
| Cold request | cleared/unique key | actual state | normal |
| Warm request | populated | same as cold | normal |
| Market open | cold and warm | forced test clock/fixture | normal |
| Market closed | cold and warm | forced test clock/fixture | normal |
| Large dataset | cold and warm | fixed | maximum supported limit |
| Small dataset | cold and warm | fixed | limit 20 |

Rank samples numerically and report nearest-rank P50, P95, and P99. Targets are
under 300 ms for cached responses and under 800 ms for uncached responses.
Synthetic unit-test duration is not reported as API latency. The structured
profile log and development headers provide the measurements when the
representative runtime is available.
