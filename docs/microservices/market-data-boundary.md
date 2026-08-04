# Market Data boundary

| Capability | Current implementations | Active path | Callers | Cache | Fallback | Facade operation |
|---|---|---|---|---|---|---|
| Quotes | resolver, legacy `getLivePrice` | `marketDataResolver` | signals, trade setups, services | Redis/general cache | cache -> Kite -> gated NSE -> opt-in Yahoo emergency | `getQuote`, `getQuotes`, `resolvePrice(s)` |
| Candles | `getCandles`, fallback chain, warehouse | Existing resolver/fallback policy | signals/backtests/jobs | MySQL + provider caches | Current chain unchanged | `getHistoricalCandles` |
| Signal candles | `resolveMarketCandles` | live tick/daily selection | Signal Engine | tick store/warehouse | Existing selection | `resolveMarketCandles` |
| Instrument identity | broker provider master, symbol normalizers | Existing caller-specific paths | brokers/market modules | master cache | provider-specific | Deferred until one canonical active operation exists |
| Provider health | `marketDataHealth`, feed logs/reports | Existing health aggregation | ops APIs | memory/DB | n/a | `getProviderHealth` |
| Market status | `marketHours` | IST policy | routes/resolver | none | overrides unchanged | `getMarketStatus` |
| Live ticks | connection manager/tick bus/Redis bridge | Existing streaming owner | WebSocket/signal lifecycle | Redis/in-memory | broker-specific | Not exposed yet; ownership stays put |

The facade delegates directly to the active resolver. Provider order, flags, quota behavior, cache TTLs, stale policy, symbol normalization, market hours, Redis, persistence, streaming, and scheduler ownership are unchanged. Deprecated Yahoo/getLivePrice paths remain for compatibility and were not deleted.
