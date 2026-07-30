# Phase 11 Focused Test Coverage

## Cache layer

`src/__tests__/cacheService.vitest.ts` exercises:

- environment/version namespaces and symbol/user scopes;
- cache hit and miss behavior;
- TTL expiry and stale-while-revalidate;
- malformed/unparseable values as safe misses;
- Redis read and write failure fallback;
- `getOrSet` persistence and concurrent request coalescing;
- pattern invalidation;
- cross-user isolation;
- secret-like key rejection and fingerprint-only cache logging.

`src/__tests__/cacheInvalidation.vitest.ts` verifies mutation dependency
invalidation and prohibits `FLUSHALL`/`FLUSHDB`.

## Optimized APIs

`src/__tests__/highImpactApiOptimization.vitest.ts` protects authentication,
pagination validation, response/error contracts, cache-aside behavior, parallel
I/O, and write-path invalidation for the optimized dashboard, rankings, ticker,
signal, and strategy paths.

The cache behavior tests additionally prove that a hit avoids loader work, a
miss loads and caches, Redis failure falls back, and user scopes cannot cross.

## Trade Setup page

`src/__tests__/tradeSetupAutomaticGeneration.vitest.ts` protects:

- authentication/input readiness gates;
- automatic generation;
- stable rerender and Strict Mode guards;
- loading, error, retry, empty, and success rendering;
- manual regeneration;
- force/bypass behavior;
- symbol/strategy/timeframe generation identity and mutation key;
- closed-market reuse and server-side duplicate protection.

## Trade Setup API

`src/__tests__/tradeSetupApiBehavior.vitest.ts` invokes the wrapped route with
mocked session, database, cache, lock, and market resolver boundaries. It tests:

- validation, authentication, and ownership authorization;
- active-list response compatibility;
- user-scoped cache hit and miss flows;
- cache hits avoiding provider and persistence work;
- idempotent persistence and cache population;
- manual regeneration invalidation/bypass;
- distributed-lock contention;
- duplicate concurrent request coalescing;
- Redis-unavailable in-process fallback;
- provider and database failure sanitization;
- cross-user cache identity isolation;
- use of the centralized market-data resolver.

`src/__tests__/tradeSetupApiOptimization.vitest.ts` separately protects
timeouts, deterministic identity dimensions, schema uniqueness, and the
no-full-universe-scan constraint.
