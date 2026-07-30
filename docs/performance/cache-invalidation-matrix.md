# Cache invalidation matrix

All centralized keys use the `q365:v1:{environment}:...` namespace. User scopes
are hashed by the key builder. Invalidation is cache-aside and best effort:
Redis failure never changes the result of a successful database mutation.

| Mutation | Cached reads invalidated | Scope | Mutation entry points |
| --- | --- | --- | --- |
| Signal generated | signal lists, rankings, dashboard summaries, trade setups, ticker strip | Global/domain | `saveSignals` after at least one insert |
| Signal promoted | confirmed/active signal lists, rankings, dashboard summaries, ticker strip | Global/domain | signal maturity worker after at least one promotion |
| Portfolio position added, edited, or removed | portfolio summary/context, trade setups, dashboard summary | User | `/api/portfolio` POST, PATCH, DELETE |
| Paper order placed, position closed, or account reset | paper orders/positions/account, portfolio-derived views, dashboard summary | User | paper-trading order, close-position, and account-reset routes |
| Strategy configuration or mode changed | strategy detail/list, strategy analytics, dashboard summaries | Strategy where possible; otherwise domain | strategy config update/reset/restore and single/bulk mode routes |
| Instrument master refreshed | market reference, stock detail, rankings, ticker, dashboard | Global/domain; symbol helper is available for targeted writes | `syncInstrumentsFromCdn` after rows are written |
| News ingested | news lists, intelligence/impact summaries, dashboard summaries | Global/domain | news pipeline after at least one new event |
| User preferences changed | settings, personalized signals, trade setups, dashboard summary | User | `/api/user` preference update only |

Legacy cache keys still in active read paths are deleted alongside centralized
keys during migration. Unsafe string user identifiers are never interpolated
into legacy patterns.

## Precision rules

- User mutations use opaque user-scoped patterns and do not evict other users.
- Strategy mutations use a strategy scope when an ID is available.
- Symbol-level market writers can call `invalidateMarketReferenceCaches(symbol)`.
- Global invalidation is reserved for genuinely global datasets such as the
  instrument master, rankings, and ingested market news.
- Authentication, password, broker-token, order-placement, wallet, payment,
  kill-switch, and admin-write responses are not cached.
- `FLUSHALL` and `FLUSHDB` are prohibited; deletion uses Redis `SCAN` plus
  batched key deletion through the shared Redis implementation.
