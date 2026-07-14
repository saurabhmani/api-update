# IndianAPI retention audit (final migration phase)

**Verdict: B — Keep IndianAPI.** Production features still depend on it for (1) automatic fallback when Kite cannot serve a supported request and (2) capabilities with no Kite equivalent.

Kite is the **default primary** (`MARKET_DATA_PROVIDER` unset → `kite`). IndianAPI is **not** delete-ready.

---

## Classification table

| Feature | Current provider | Why IndianAPI remains | Replacement needed? |
|--------|------------------|------------------------|---------------------|
| Live quotes / batch | Kite → **IndianAPI** → NSE → Yahoo emergency → DB | First automatic fallback on Kite auth / rate-limit / empty / error | No (keep as safety net) |
| Historical candles | Kite → **IndianAPI** → NSE / DB | Upstream fallback in `candleFallbackChain` | No |
| Symbol search | Kite → **IndianAPI** → Yahoo | Fallback after Kite miss | No |
| Movers / gainers-losers | **IndianAPI** (via MDP) | Kite has no trending/movers API (`UnsupportedFeatureError`) | Yes — only if product drops movers or finds another source |
| Trending / price shockers / NSE most-active | **IndianAPI** | Same | Yes — only if product drops these |
| Market / company news | **IndianAPI** | Kite has no news feed | Yes — only with a dedicated news provider |
| Corporate intel | **IndianAPI** | Kite has no corp actions / filings API in this cutover | Yes — future corp data vendor |
| Fundamentals | **IndianAPI** (MDP) | Kite unsupported stub | Optional enrichment vendor |
| Mutual funds | **IndianAPI** adapter (no production route today) | No Kite MF equity surface in MDP; adapter retained for catalog / future | Wire a route or delete later if never used |
| Forecasts / target price | **IndianAPI** adapter (optional) | Not on Kite; no dedicated UI route required today | Optional |
| 52-week high/low | **IndianAPI** adapter + unused provider wrapper | Not on Kite | Optional UI / drop |
| Commodities | **IndianAPI** adapter only | Out of equity cutover scope | Optional |
| Quota / compliance | **IndianAPI-only** tracker | Kite uses rate-limit events — **no fake monthly quota** | Keep while IndianAPI hops exist |
| `INDIANAPI_PRIMARY` | Override flag | Immediate recovery without deleting Kite config | Keep |

---

## Remaining IndianAPI files (required)

| File | Role |
|------|------|
| `src/providers/adapters/IndianAPIAdapter.ts` | HTTP adapter + breaker + transport |
| `src/providers/adapters/indianApiUsageTracker.ts` | Daily/monthly/per-run quota |
| `src/lib/marketData/providers/indianApiEndpoints.ts` | Endpoint catalog + config |
| `src/lib/marketData/providers/indianApiProvider.ts` | Envelope wrapper (quotes/historical for resolver/candles) |
| MDP / resolver / batchScheduler / candle jobs / monitoring / `/api/usage` | Call sites |

---

## Dead code removed in this phase

| Removed | Reason |
|---------|--------|
| `src/lib/marketData/kiteSession.ts` | Neutralized “Kite removed” stub — **zero importers** |
| `unverifiedEndpoints()` in `indianApiEndpoints.ts` | Unused helper |
| `getIntradayCandles` / `getBseBatchLivePrice` provider wrappers | Zero callers; intraday route already `removedEndpoint` on the adapter |

**Not removed:** IndianAPIAdapter, usage tracker, fallback paths, quota system, mutual-fund/forecast adapter methods (intentional capability catalog + future use).

---

## Dependencies

No IndianAPI-specific npm package exists. Stack uses `axios` + custom adapter. **Nothing to remove from `package.json`.**

---

## Environment variables still required

| Variable | Still required? | Purpose |
|----------|-----------------|---------|
| `INDIANAPI_API_KEY` (aliases `INDIANAPI_KEY` / `INDIAN_API_KEY`) | **Yes** | Fallback + unsupported features |
| `INDIANAPI_BASE_URL` | **Yes** | Host |
| `INDIANAPI_PRIMARY` | **Yes** | Force IndianAPI recovery |
| `INDIANAPI_TIMEOUT_MS` | **Yes** | Request timeout |
| `INDIANAPI_RETRY_ATTEMPTS` | **Yes** | Adapter retries |
| `INDIANAPI_BLOCK_OUTSIDE_MARKET` / `INDIANAPI_BLOCK_ALL_OFF_HOURS` | **Yes** | Off-hours gates |
| `INDIANAPI_DAILY_LIMIT` / `INDIANAPI_DAILY_SOFT_LIMIT` | **Yes** | Quota |
| `INDIANAPI_MONTHLY_LIMIT` / `TARGET` / `CEILING` | **Yes** | Quota / compliance |
| `INDIANAPI_PER_RUN_LIMIT` | **Yes** | Per-run cap |
| `INDIANAPI_EMULATED_BATCH_MAX` (+ concurrency / gap / 429 envs) | **Yes** | Transport |
| `INDIANAPI_ENABLED` | **Display only** | Shown in `/api/debug/env-check`; does **not** gate routing after Phase 9 (kept for ops readability) |

Kite vars (`KITE_API_KEY`, `KITE_ACCESS_TOKEN`, …) remain required for the default primary path.

---

## Recommendation

### **B) Keep IndianAPI**

Uninstalling IndianAPI would break movers, news, corporate, trending, fundamentals, and quote/historical fallback. That is **not** safe for production.
