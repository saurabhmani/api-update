# API Performance Observability

## Scope

Phase 10 extends the existing `withApiHandler`, structured logger, canonical
MySQL wrapper, centralized cache service, and `/api/metrics` Prometheus
endpoint. It does not introduce another logger, Redis client, or monitoring
service.

## Structured request log

Every route wrapped by `withApiHandler` emits one `API performance` event with:

- normalized route name and HTTP method;
- generated request ID;
- total response duration;
- cumulative database and Redis duration;
- external-provider duration when explicitly observed;
- database query count;
- cache outcome and hit/miss/stale counts;
- response size when it can be determined without consuming a streaming body;
- safe error category.

Numeric and UUID route segments are normalized to `:id` for performance labels.
User IDs, session data, authorization headers, cache keys, provider tokens, and
request/response bodies are not added to metrics.

## Metrics

The existing `GET /api/metrics` endpoint now also exports:

| Metric | Type | Labels |
|---|---|---|
| `q365_api_request_duration_ms` | cumulative counter | `route`, `method` |
| `q365_api_cache_hit_total` | counter | `route`, `method` |
| `q365_api_cache_miss_total` | counter | `route`, `method` |
| `q365_api_db_duration_ms` | cumulative counter | `route`, `method` |
| `q365_api_provider_duration_ms` | cumulative counter | `route`, `method` |
| `q365_trade_setup_generation_duration_ms` | cumulative counter | none |
| `q365_trade_setup_generation_total` | counter | none |
| `q365_trade_setup_generation_deduplicated_total` | counter | none |

These are process-local monotonic values and reset when the process restarts,
matching the repository's existing Prometheus counter behavior. Multi-replica
deployments should aggregate them at scrape/query time.

## Instrumented boundaries

- Canonical `db.query`: database duration and practical query count.
- Central cache service: Redis duration and cache hit/miss/stale outcomes.
- Trade Setup generation: provider duration, total generation duration,
  in-process coalescing, and distributed-lock deduplication.
- `withApiHandler`: request correlation, total duration, response size, error
  category, and final metric commit.

Redis and telemetry failures do not change API behavior. The metrics contain no
raw cache key; existing cache logs continue to use a SHA-256 fingerprint.
