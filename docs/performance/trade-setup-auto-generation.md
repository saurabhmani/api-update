# Trade Setup Automatic Generation

## Before

The Trade Setup page loaded existing rows but generation depended on an
explicit user action. Generation did not have a complete deterministic
identity, cross-request lock, recent-result reuse, or complete client readiness
guard. Re-renders and development Strict Mode could therefore initiate
duplicate work if generation were triggered automatically.

## After

For an authenticated visit:

1. React Query loads active user-owned setups.
2. If none exist, a second enabled query loads one ranked seed symbol.
3. Only after authentication, active-list success and a symbol are available,
   a guarded effect requests generation.
4. The client identity is `user + symbol + strategy + timeframe`.
5. A `useRef` guard prevents repeat mutation during ordinary re-renders and
   Strict Mode effect replay.
6. The server's unique generation identity, upsert, promise map and distributed
   lock provide the authoritative duplicate protection.
7. Success invalidates only the active Trade Setup query and renders the
   returned/persisted setup.

The page displays explicit loading, error with retry, empty, progress, note and
success states. Requests managed by React Query receive cancellation signals
for active-list and seed queries.

## Query and mutation identities

```text
active list: ["trade-setup", "active"]
seed symbol: ["trade-setup", "seed-symbol"]
generation:  ["trade-setup", "generate", symbol, strategy, timeframe]
```

Automatic generation uses `force: false`. Manual **Regenerate** uses
`force: true`, clears the deterministic server cache entry, bypasses recent
result reuse, and generates again.

## Server generation identity

The deterministic identity includes:

- authenticated user ID;
- symbol;
- strategy ID;
- timeframe;
- market session/latest completed trading date;
- signal engine/strategy version;
- latest candle freshness version.

This prevents one user, symbol, strategy, timeframe or market context from
receiving another identity's result.

## Generation flow

1. Require a session.
2. Validate JSON, symbol, strategy and timeframe.
3. Verify the symbol belongs to the user's watchlist/portfolio or ranked
   universe.
4. Resolve the market/freshness identity.
5. On normal requests, check the user-scoped Redis result cache.
6. Check a recent active database result.
7. Check the in-process promise map.
8. Acquire a short Redis distributed lock.
9. Recheck the cache after lock acquisition.
10. Fetch through `marketDataResolver.resolvePrice`; never bypass provider
    policy and never launch a full-universe scan.
11. Generate and persist with `ON DUPLICATE KEY UPDATE`.
12. Cache the normalized result.
13. Release the owned lock safely.

The provider timeout is 20 seconds, database timeout is 5 seconds, and
distributed lock TTL is 45 seconds. These are currently code constants.

## Closed-market behavior

When the market is closed, the generation identity incorporates the latest
completed trading day and candle freshness version. An unchanged result is
cached for one hour, preventing pointless regeneration while market data is
unchanged.

## Failure behavior

- Redis unavailable: continue with database/provider paths and in-process
  coalescing.
- Lock already held: return `202` with `Retry-After: 2`.
- Provider/database timeout: return a safe `504`.
- Other generation failure: return a sanitized `500`.
- Raw provider, database, token and user details are not returned or logged by
  the Trade Setup failure path.

## Tests

See `src/__tests__/tradeSetupAutomaticGeneration.vitest.ts`,
`src/__tests__/tradeSetupApiOptimization.vitest.ts`, and
`src/__tests__/tradeSetupApiBehavior.vitest.ts`.
