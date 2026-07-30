# Redis Cache Strategy

## Architecture

`src/lib/redis.ts` owns the single shared `ioredis` client and the in-process
fallback. Higher-level application caching is centralized under:

- `src/lib/cache/cacheService.ts`;
- `src/lib/cache/cacheKeys.ts`;
- `src/lib/cache/cachePolicy.ts`;
- `src/lib/cache/cacheClassification.ts`;
- `src/lib/cache/cacheInvalidation.ts`.

Routes must not create unrelated Redis clients.

The cache service supports `get`, `set`, `delete`, `deleteByPattern`,
`getOrSet`, safe envelope parsing, configurable TTL, stale-while-revalidate,
cache state logging, promise coalescing, and graceful failure.

## Key format and scoping

Keys use:

```text
q365:{version}:{environment}:{domain}:{resource}:{scope...}
```

Examples:

```text
q365:v1:production:market:quote:RELIANCE
q365:v1:production:signals:list:user-{opaque-hash}:30d
q365:v1:production:portfolio:summary:user-{opaque-hash}
q365:v1:production:trade-setup:result:user-{opaque-hash}:RELIANCE:...
```

User IDs are transformed to a 16-character SHA-256-derived opaque scope. Key
builders reject sensitive component names and token-like values. Raw keys are
not logged; cache logs contain only a short SHA-256 fingerprint.

Never put cookies, passwords, MFA secrets, broker tokens, API keys, encryption
keys, or personally sensitive data in keys, cached payload logs, or telemetry.

## TTL catalogue

All values are seconds and live in `CACHE_TTL`.

| Policy | TTL | Stale-while-revalidate |
|---|---:|---:|
| Market quote | 5 | 5 |
| Market snapshot | 15 | 15 |
| Market overview | 30 | 30 |
| Ticker strip | 30 | route-selected |
| Degraded ticker strip | 10 | none |
| Stock details | 60 | 60 |
| Market status | 30 | 30 |
| Signals/personalized signals | 30 | 30 / none |
| Rankings | 60 | 60 |
| News list | 120 | 120 |
| Trade Setup | 30 | none |
| Dashboard summary | 30 | 30 |
| Strategy summary | 60 | 60 |
| Health summary | 15 | 15 |
| Portfolio/paper trading | 15 | none |
| Watchlist | 30 | none |
| User settings | 300 | none |
| Subscription/usage | 60 | none |
| Static reference | 3600 | 3600 |
| Historical candles | 86400 | none |

Trade Setup extends the result TTL to one hour when the market is closed and
the deterministic market/freshness identity is unchanged.

## Cache classification

Explicit GET/HEAD rules classify public, global and user-scoped reads. The
following remain no-cache by default:

- login, logout, registration, password reset and MFA;
- broker OAuth, connection, token and order operations;
- live/paper trading and kill switches;
- wallet, subscription and billing mutations;
- admin and other `POST`, `PUT`, `PATCH`, or `DELETE` mutations.

No POST endpoint is currently allowlisted as a generic cacheable calculation.
Trade Setup generation performs its own reviewed idempotent result reuse and
does not rely on broad response caching.

## Failure and stampede behavior

Redis errors are swallowed at the cache boundary and logged without raw keys.
Safe reads continue to loaders backed by MySQL or the approved provider path.
Writes are best effort.

`getOrSet` coalesces identical work within one process. Trade Setup adds a
short Redis `SET NX EX` distributed lock. When Redis is unavailable, the
in-process promise map still prevents duplicate work inside that process, but
is not treated as a cross-replica lock.

Pattern invalidation uses Redis `SCAN`, never `KEYS`, `FLUSHALL`, or `FLUSHDB`.

## Invalidation rules

| Mutation | Invalidated domains |
|---|---|
| Signal generated | signals, rankings, dashboard, Trade Setup, ticker |
| Signal promoted | signals, rankings, dashboard, ticker |
| Portfolio changed | that user's portfolio, Trade Setup and dashboard |
| Paper order changed | that user's paper, portfolio and dashboard |
| Strategy changed | strategy details/list/analytics and dashboard |
| Market reference changed | affected market/stock plus rankings, ticker and dashboard |
| News ingestion completed | news, intelligence and dashboard |
| User settings changed | that user's preferences, signals, Trade Setup and dashboard |

Precise versioned patterns are preferred; legacy patterns are retained only
where existing caches still use them.

## Environment variables

The runtime currently reads:

```text
REDIS_HOST
REDIS_PORT
REDIS_USER
REDIS_PASSWORD
REDIS_DISABLED
CACHE_KEY_VERSION
CACHE_ENV_PREFIX
```

`REDIS_DISABLED=1` selects the in-process fallback. `REDIS_URL`,
`REDIS_CONNECT_TIMEOUT_MS`, `REDIS_COMMAND_TIMEOUT_MS`, `CACHE_PREFIX`,
`CACHE_DEFAULT_TTL_SECONDS`, `TRADE_SETUP_CACHE_TTL_SECONDS`, and
`TRADE_SETUP_LOCK_TTL_SECONDS` are not currently read and must not be assumed
to work without an implementation change.
