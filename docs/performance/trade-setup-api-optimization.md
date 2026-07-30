# Trade Setup API optimization

The generation contract is now one symbol per request:

```json
{
  "symbol": "RELIANCE",
  "strategyId": "auto",
  "timeframe": "swing",
  "force": false
}
```

`symbol`, `strategyId`, and `timeframe` are required. Symbols must have a safe
NSE-style identifier and must exist in the ranked universe or in the
authenticated user's watchlist or portfolio. A named strategy must exist in
the strategy registry; `auto` permits the engine's highest-ranked strategy.

The deterministic identity contains the user, symbol, strategy, timeframe,
market session/trading date, signal-engine version, and latest candle timestamp.
The same identity is used for the result cache and database idempotency.

Generation follows this order:

1. Authenticate and validate the request.
2. Authorize the symbol and load its candle freshness version with database
   timeouts.
3. Check the user-scoped Redis result.
4. Check the user's recent database result.
5. Coalesce identical promises in the current process.
6. Acquire a short Redis-only distributed lock and recheck the cache.
7. Resolve the current price through `marketDataResolver` and run the
   single-instrument signal generator under a provider timeout.
8. Upsert one user-owned setup using its unique generation identity.
9. Cache the normalized response and safely release the token-owned lock.

When Redis is unavailable, the in-process promise map still coalesces identical
requests, but it is not reported or treated as a distributed lock. Manual
regeneration uses `force: true` and deletes the exact current result key before
generation.

The page requests one top-ranked seed symbol only when the user has no active
setup. It never asks the generation endpoint to scan or synchronize a universe.
