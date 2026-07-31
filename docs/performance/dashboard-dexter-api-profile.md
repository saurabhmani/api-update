# Dashboard and Dexter API performance profile

## Scope and dependency map

### Dashboard page

```text
/dashboard
  -> DashboardPage
     -> GET /api/dashboard
        -> requireSession
        -> user-scoped dashboard Redis entry
        -> resolveUserFeedMeta
        -> GET /api/signals?action=top&limit=20
        -> GET /api/signals/engine-health
           -> GET /api/signals
           -> GET /api/signals/daily-report
           -> GET /api/signals/backtest?window=7D
           -> candles and learning-state database probes
        -> GET /api/signals/daily-report
        -> GET /api/signals/backtest?window=1D
        -> GET /api/news-engine?action=summary
        -> GET /api/manipulation?action=health
        -> GET /api/options/intelligence?symbol=NIFTY
        -> GET /api/backtests
        -> dashboard response processing and Redis write
  -> BrokerStatusBar -> GET /api/brokers/status
  -> AppShell -> useAuth, ticker strip, notification summary
```

The Dashboard aggregator already launches its independent modules with
`Promise.allSettled`. The dependency map proves duplicated backend work:
`engine-health` calls Signals, daily-report, and backtest while Dashboard calls
the same domains directly. This is retained until measured profiles establish
which shared dependency dominates and a shared service extraction can preserve
both response contracts.

### Dexter page

```text
/dexter
  -> DexterPage
     -> GET /api/signal-engine/dexter?days=7&conviction=...
        -> requireSession
        -> user-scoped Dexter Redis entry
        -> q365_signals (bounded to 100 rows)
        -> q365_signal_explanations (one IN query)
        -> q365_signal_reasons (one IN query)
        -> news context (deduplicated per symbol)
           -> news score/event repositories
        -> feedback context (deduplicated per strategy/regime)
           -> outcomes
           -> adaptive recommendations
           -> confidence calibration
        -> contextual modifier and deterministic Dexter narrative
        -> Redis write and JSON response
  -> useEventStream (refresh on dexter:update or signal:new)
  -> AppShell -> useAuth, ticker strip, notification summary
```

The scoped Dexter route does not call an LLM/model provider and does not stream
tokens. Its “AI” output is the deterministic `buildDexterNarrative` calculation.
Consequently provider completion and time-to-first-token are not applicable to
this route; reporting fabricated AI timings would be incorrect.

## Instrumentation

Both routes now record authentication, validation, cache, dependency/database,
context, market status, response processing, serialization, total duration,
database query counts, Redis outcomes, provider counts, row counts, payload
bytes, heap delta, and ranked slow steps.

Slow-step thresholds are 20, 50, 100, 250, 500, and 1,000 ms. Logs contain a
request ID but no raw user ID, cookie, authorization header, cache key, API key,
broker token, or prompt. Timing response headers are emitted only in development
or when `PERFORMANCE_BENCHMARK_HEADERS=1` is explicitly enabled.

## Frontend request findings

- Dashboard had a Strict Mode duplicate initial fetch risk. A stable ref now
  permits one initial request.
- Dashboard visibility refresh could immediately duplicate a recent request.
  It now requires the last successful load to be at least 30 seconds old.
- Dashboard overlapping refreshes now share an in-flight guard.
- Dexter had the same Strict Mode risk and could start a 10-second poll while a
  slow initial request was still running.
- Dexter now guards by request identity, cancels obsolete requests, prevents
  overlap, polls every 30 seconds only when SSE is disconnected, and continues
  to respond immediately to relevant SSE events.

## Cache policy

| Data | Scope | Fresh TTL | Stale window | Empty TTL |
|---|---|---:|---:|---:|
| Dashboard response | Opaque user | 30 s | 30 s | Existing response policy |
| Dexter intelligence | Opaque user + days + symbol + conviction | 30 s | 30 s | 10 s |

Redis failure falls back to the existing database/service path. Dashboard uses
the centralized cache service and Dexter now does the same. Concurrent cache
miss coalescing is available in `cacheService.getOrSet`; conversion of the two
routes to that primitive is pending benchmark evidence because the current
explicit cache-aside flow also carries route-specific profiling and negative
TTL behavior.

## Request-path work removed

Dexter no longer runs `ensureSignalEngineSchemas` during a normal GET. Schema
ownership remains with application startup and canonical migration/ensure
commands. No scanner, signal generation, maturity promotion, news ingestion, or
universe scan was added to either request path.

## Benchmark status

Authenticated production benchmarks have not yet been executed for these two
routes. The repository currently has no unexpired session. Targets remain
unverified until `npm run benchmark:dashboard-dexter -- --requests=100` is run
against the production build with representative data.
