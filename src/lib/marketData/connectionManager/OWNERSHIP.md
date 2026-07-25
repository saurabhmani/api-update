# Broker streaming ownership (Phase 5)

## Product model

Quantorus is **multi-user**. Auth (`users` / sessions) and `broker_connections`
are per-user. Interactive market-data streams must therefore be tenant-safe.

This is **not** an intentional single-tenant process.

## Broker API limits

| Broker | Limit |
|--------|--------|
| Zerodha Kite Connect | One WebSocket ticker per `api_key` + `access_token` (per login session). Multiple users ⇒ multiple in-process ticker instances. |
| Shoonya / Noren | One WebSocket per trading account. |

## Connection keys

```ts
interface ConnectionKey {
  userId: string;
  provider: 'zerodha' | 'shoonya';
}
// Map key: `${userId}:${provider}`
```

Registry: `src/lib/marketData/connectionManager/`

Each instance tracks: state, session version, subscriptions, reconnect
attempts/timer, last tick / poll / error, refCount, authenticated session.

## System feed (jobs + shared tickBus)

Background scanners and the process-global `kiteTicker` / `tickBus` /
`streamServer` use a **system** feed owned only by:

```
SYSTEM_MARKET_DATA_USER_ID=<quantorus user id>
```

Rules:

- User OAuth writes `kite:active-session:user:{userId}`.
- Only the system feed owner also updates `kite:active-session:system`
  (and legacy `kite:active-session`).
- Global `getKiteClient().hydrateAccessTokenFromSession()` loads the
  **system** session / that owner's `broker_connections` row — never
  `ORDER BY … LIMIT 1` across all users.
- Disconnecting user A never clears user B's Redis key or tears down B's
  registry instance. The global ticker is disconnected only if A is the
  system feed owner.

If `SYSTEM_MARKET_DATA_USER_ID` is unset, interactive Zerodha still works
via per-user connection instances, but the process-global Kite ticker is
**not** overwritten by arbitrary OAuth callbacks.

## Streaming lifecycle (Phase 7)

Both Zerodha and Shoonya use `StreamingLifecycle`
(`streamingLifecycle.ts`) so the wire path is equivalent:

```
credentials → connect → authenticate socket → subscribe → tick
→ normalize → liveFeedState → broadcast → reconnect (bounded)
```

Guarantees:

- connect / disconnect are idempotent; concurrent connects share one promise
- session bump (new OAuth) cancels reconnect timers and ignores stale sockets
- OAuth replaces only that user's session (`userId:provider`)
- listeners are wired once; subscriptions restore after auth
- temporary network errors → bounded backoff (max 40, delay capped at 30s)
- permanent auth errors → stop retrying + `login_required`
- ticks fan out via `publishNormalizedLiveTick` → `recordLiveFeedTick` + `tickBus`

## Freshness (Phase 8)

Freshness is keyed by `userId` + `provider` (connection). There is **no**
single global freshness value shared across users.

```ts
interface LiveFeedState {
  userId: string;
  provider: 'zerodha' | 'shoonya';
  status:
    | 'not_connected' | 'login_required' | 'connecting' | 'connected'
    | 'waiting_for_data' | 'fresh' | 'delayed' | 'stale'
    | 'closed_market' | 'error';
  lastReceivedAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
}
```

`referenceTime = max(valid(lastReceivedAt), valid(lastSuccessAt))`.
Socket/OAuth auth updates connection phase only — never marks `fresh`.
User A's Shoonya feed cannot become fresh because User B's Kite received a tick.

## User-facing APIs (Phase 9 / 11)

Flow for market APIs:

```
request → authenticate → resolveUserLiveProvider → broker adapter
→ fetch/normalize → respond
```

Never uses `MARKET_DATA_PROVIDER` for Zerodha vs Shoonya selection.

Resolution codes (Phase 11):

| Condition | status |
|-----------|--------|
| No active broker | `not_connected` |
| Connected but none selected | `needs_selection` |
| Active Shoonya unavailable | `shoonya_error` |
| Active Zerodha unavailable | `zerodha_error` |

Do **not** silently return another provider's live data.
Warehouse / Yahoo may only be used when product-supported, labeled
(`dataOrigin`, `fallbackUsed`, `fallbackSource`), and must not mutate
the user's selected source.

Market responses use:

```json
{ "provider": "shoonya", "status": "fresh", "data": {}, "dataOrigin": "shoonya_live" }
```

Never expose access tokens or broker session secrets.
Helpers: `userMarketApi.ts`, `userProviderResolution.ts`

## Signal generation origins (Phase 10)

```ts
type DataOrigin =
  | 'zerodha_live'
  | 'shoonya_live'
  | 'database'
  | 'scheduled_ingestion'
  | 'fallback';
```

| Path | Kind | Default origin |
|------|------|----------------|
| Phase 4 / cron / daily scan | candle DB / scheduled | `database` |
| Closed-market loader | candle DB | `database` |
| `/api/signals` live LTP enrich | poll + user broker | `zerodha_live` / `shoonya_live` |
| Candle EOD ingest | scheduled | `scheduled_ingestion` |
| System resolver (only if `SIGNALS_LIVE_FALLBACK=1`) | fallback | `fallback` |

Live enrich for a Zerodha user uses Zerodha quotes; Shoonya users use Shoonya.
Never claim broker live when prices came from Yahoo/Kite/warehouse.
Catalog: `src/lib/signals/dataOrigin.ts` (`SIGNAL_PATH_CATALOG`).

## /data-source UI (Phase 12)

Shows Zerodha + Shoonya connection status, active source, freshness,
last live-data time, login-required / error states, switch + disconnect.

OAuth connect primary rules:
- first connected broker → mark active
- another broker already active → keep selection (no silent switch)

## Background jobs (Phase 13)

Jobs are classified separately from user live streams
(`src/lib/marketData/jobs/jobClassification.ts`):

| Class | Meaning |
|-------|---------|
| `broker_neutral_db` | DB / news / scans — no broker tokens |
| `system_owned_ingestion` | Shared warehouse / process-global feed |
| `user_specific_broker` | Interactive per-user only |

### System-owned ingestion rules

1. Require explicit `SYSTEM_MARKET_DATA_USER_ID` (Quantorus service account).
2. Load that user's Zerodha `broker_connections` row only — never
   `ORDER BY … LIMIT 1` across users, never an arbitrary customer token.
3. Redis system session must belong to the same system user id.
4. Do not apply one user's connection globally for all customers.

### Candle source / dedupe

Shared `candles` upserts use `source` + precedence
(`candleSourcePolicy.ts` / `upsertWarehouseCandle`):

| Source | Precedence | Notes |
|--------|------------|-------|
| `nse_bhavcopy` | 100 | Official EOD — wins over Kite |
| `kite` | 80 | System Zerodha historical only |
| `yahoo` | 20 | Emergency |
| `shoonya` | 0 | **Blocked** from shared warehouse unless `SYSTEM_ALLOW_SHOONYA_CANDLE_INGEST=1` |

Lower-precedence writers never overwrite higher-precedence rows for the
same `(instrument_key, candle_type, interval_unit, ts)`.

## Provider parity tests (Phase 14)

Focused suite: `src/__tests__/providerParityPhase14.vitest.ts`

- Provider resolution (Zerodha / Shoonya / both / none / no silent switch)
- Connection isolation (multi-user Zerodha + Shoonya, token refresh)
- Streaming contract for both brokers (connect → tick → reconnect → restore)
- API routing + origin stamps (env cannot override user provider)
- Failure cases (expired session, Redis unset system user, WS drop,
  instrument miss, concurrent OAuth, closed market, no recent data)
