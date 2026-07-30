# API Optimization Architecture

## Scope and inventory

The Phase 1 audit covers all 332 `src/app/api/**/route.ts` files found in the
current repository. The machine-readable inventory is
`docs/performance/api-optimization-inventory.json`; the review-friendly version
is `docs/performance/api-optimization-inventory.md`.

Each route record includes its path, methods, authentication and authorization
requirements, response scope, database/provider/Redis use, existing caching,
cache suitability, mutations, financial effects, N+1 and duplicate-query
signals, parallelizable work, payload/pagination/validation findings,
`withApiHandler` adoption, and request/timing logging.

The audit itself did not change route behavior. Optimization was performed
after prioritization and in bounded batches.

## Prioritization model

Priority scores favor:

1. Dashboard and page-load impact.
2. High request frequency and repeated identical requests.
3. Market-data or external-provider dependency.
4. Multiple or potentially slow database queries.
5. Large payloads or missing pagination.
6. Expensive calculations and full-universe work.

The first implementation batch focused on:

| API/boundary | Main changes |
|---|---|
| `GET /api/dashboard` | Preserved session guard; user-scoped cache; parallel upstream work; request cancellation on the client |
| `GET /api/rankings` | Strong pagination/filter validation; parallel freshness query; safe errors; centralized handler |
| `GET /api/ticker` | Centralized short cache; cache hit bypass; safe fallback and errors |
| `GET/POST /api/trade-setups` | Validation, ownership, resolver policy, idempotency, locking, cache, timeouts, safe errors |
| Selected portfolio, paper, news, strategy and signal writes | Precise dependent-cache invalidation |
| `withApiHandler` | Request IDs, timing headers, structured performance logs and Prometheus accounting |
| Canonical `db.query` | Request-scoped database duration and practical query count |

This is deliberately not a mass rewrite of all audited routes.

## API handler boundary

`withApiHandler` remains the preferred compatible wrapper. It preserves
`NextResponse` responses and therefore does not force an envelope change on
routes that already return one. It supplies:

- `X-Request-ID`;
- `Server-Timing`;
- typed/sanitized error mapping;
- route, method, status and total duration logging;
- database, Redis and provider timing attribution;
- cache hit/miss visibility;
- practical response-size measurement;
- normalized route labels for numeric/UUID parameters.

Authentication and authorization remain route-owned through `requireSession`,
`requireAdmin`, and `requirePermission`.

## Database optimization

Only inspected query patterns were indexed. Canonical MySQL migration ownership
is in `src/lib/db/migrateCanonical.ts`; no PostgreSQL service migration was
mixed into the active runtime path.

Added indexes:

- `user_sessions(user_id, expires_at)`;
- `portfolio_positions(portfolio_id, added_at)`;
- `trade_setups(user_id, status, created_at)`;
- `news(is_published, category_id, published_at)`;
- `paper_orders(account_id, created_at)`.

The complete rationale, duplicate check, write overhead, rollback SQL and
staging `EXPLAIN` commands are in
`docs/performance/database-index-optimization.md`.

## Client request behavior

React Query retains short real-time freshness. The global default remains a
30-second stale time, with a five-minute garbage-collection time and no
automatic window-focus refetch. Individual real-time hooks retain explicit
short policies.

Optimized hooks use stable primitive keys, `enabled` gates, `AbortSignal`,
visibility-aware polling, targeted invalidation, and deferred search input.
Dashboard loads cancel obsolete requests and no longer append cache-defeating
timestamps.

## Security invariants

- Authentication, MFA, broker, order, payment, wallet and kill-switch
  mutations are never cached by default.
- Mutation responses are no-store unless a POST is explicitly reviewed as a
  side-effect-free calculation. The current POST allowlist is empty.
- User cache keys use an opaque SHA-256-derived scope.
- Raw keys, cookies, credentials, tokens, request bodies and user IDs are not
  emitted in the new performance metrics.
- Redis failure does not prevent safe MySQL/provider fallback.

## Related documents

- `docs/performance/redis-cache-strategy.md`
- `docs/performance/trade-setup-auto-generation.md`
- `docs/performance/api-optimization-report.md`
- `docs/performance/api-observability.md`
- `docs/performance/client-request-optimization.md`
- `docs/performance/phase-11-test-coverage.md`
