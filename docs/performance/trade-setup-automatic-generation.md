# Trade Setup automatic generation

## Existing behavior discovered

- Page: `src/app/trade-setups/page.tsx`.
- API: `src/app/api/trade-setups/route.ts`.
- Authentication: both reads and generation require a valid session.
- The page selects one top-ranked seed symbol when no user-owned setup exists.
  Its generation inputs are that symbol, strategy `auto`, and timeframe `swing`.
- Generation is stateful. It calls the signal engine and market-data resolver,
  expires existing active rows, and inserts new `trade_setups` rows.
- The old POST was not idempotent and had no concurrent-generation protection.
- Loading and empty states existed, but errors were swallowed. Generation was
  manual and the page polled every ten seconds without regard to market state.

## Implemented behavior

- React Query loads active setups automatically once authentication resolves.
- Generation runs only after that query succeeds with an empty result.
- A stable user/strategy/timeframe guard prevents render and Strict Mode repeats.
- React Query passes its abort signal to `fetch`, so obsolete reads are cancelled.
- The server caches completed generation results by opaque user, symbol,
  strategy, timeframe, completed-market-session context, engine version, and
  candle freshness version.
- A shared Redis `SET NX EX` lock prevents concurrent generation for the same
  user, symbol, strategy, and timeframe. An in-process promise map coalesces
  requests when Redis is unavailable without pretending to be distributed.
- Closed-market generation results are reused for one hour. Open-market results
  use the central trade-setup TTL.
- A concurrent caller receives `202` with `generationStatus: in_progress`; the
  page polls only while that state is active.
- Manual regeneration sends `force: true`, deletes the relevant cached result,
  and deliberately runs generation again.
- The page now exposes loading, success, empty, and retryable error states.
