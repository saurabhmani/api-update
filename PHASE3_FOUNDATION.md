# Phase 3 — Microservices Foundation

**Architecture freeze (Priority 0):** Phase 3 work does NOT start
until Phase 1 (provider abstraction) and Phase 2 (PostgreSQL cutover)
are complete. Every service reads normalized data through the
`MarketDataProvider` contract; the database is PostgreSQL only; Kite
is broker/execution only.

**Status:** Foundation only. No service extracted yet. Existing UI
is untouched and keeps running exactly as before.

This document describes what's in this PR, how to run it, and what
gates still have to clear before we actually extract services.

---

## What this PR is

A set of **shared packages** and **one reference service** that
establish the contracts every future service will follow:

```
packages/
  contracts/            # shared types: events, API shapes, correlation
    src/
      api.ts            # GetSnapshotResponse, HealthResponse, SERVICES registry
      events.ts         # QuantorusEvent union, makeEvent helper
      correlation.ts    # CORRELATION_HEADER, ensureCorrelationId
      index.ts
  eventbus/             # publish/subscribe abstraction
    src/
      bus.ts            # EventBus interface, InProcessEventBus, DLQ
      index.ts
  rpc/                  # service-to-service HTTP client
    src/
      client.ts         # rpcGet, RpcError, typed `marketIngestion` client
      index.ts

services/
  market-ingestion/     # reference service — port 4100
    src/
      config.ts         # env parsing
      handlers.ts       # snapshot / historical / health logic
      server.ts         # Node http.Server entry point
    tsconfig.json

src/
  app/api/market/v2/
    quote/route.ts      # Next.js gateway route that RPCs to the service
```

`tsconfig.json` gained three path aliases:
`@contracts/*`, `@eventbus/*`, `@rpc/*`. Nothing else in the app
config changed.

---

## What this PR is NOT

- ❌ Not a service split. Only `market-ingestion` has its own process
  and only as a demo — the v1 `/api/market/quote` route still works
  in-process.
- ❌ Not Dockerized. Your deployment target (VPS / k8s / ECS) drives
  the Dockerfile shape; call that separately.
- ❌ Not a DB split. All services read the same Postgres (when
  Phase-2 migration completes) and the same MySQL (today).
- ❌ Not extracting Services 2–6 (Intelligence, Signal, Alerts,
  Portfolio, Gateway). Those require Phase-1 Tier 0 done first —
  see `MIGRATION_PLAYBOOK.md`.

---

## How to run

### 1. Start the market-ingestion service

```bash
npx tsx services/market-ingestion/src/server.ts
# → market-ingestion listening { port: 4100, ... }
```

(Add to `package.json` scripts when ready:
`"service:ingestion": "tsx services/market-ingestion/src/server.ts"`)

### 2. Start the Next.js app as usual

```bash
npm run dev
```

### 3. Exercise both paths

```bash
# v1 — in-process, same as before
curl "http://localhost:3000/api/market/quote?symbol=RELIANCE"

# v2 — gateway → RPC → service → MarketDataProvider
curl "http://localhost:3000/api/market/v2/quote?symbol=RELIANCE"

# direct to the service (for debugging)
curl -H "Authorization: Bearer dev-only-rotate-me" \
     "http://localhost:4100/snapshot?symbol=RELIANCE"

# health
curl "http://localhost:4100/health"
```

---

## Cross-service contracts (read this before writing a new service)

### Correlation IDs (mandatory)

Every inbound request MUST extract or mint an id:

```ts
import { ensureCorrelationId, CORRELATION_HEADER } from '@contracts/correlation';
const correlationId = ensureCorrelationId(req.headers);
```

It travels on the `x-correlation-id` header outbound and in every
log line. The RPC client attaches it automatically.

### Events (mandatory for async signals)

```ts
import { makeEvent } from '@contracts/events';
import { bus } from '@eventbus/bus';

await bus.publish(makeEvent('market.snapshot.updated', {
  symbol: 'RELIANCE',
  snapshot,
  source: 'indian',
  data_quality: 'live',
}, correlationId));
```

Defined event names:
- `market.snapshot.updated`
- `corporate.event.ingested`
- `signal.generated`
- `alert.triggered`

Adding a new event = add it to `packages/contracts/src/events.ts` in
a single commit with the subscriber that handles it.

### Service-to-service calls (mandatory)

```ts
import { marketIngestion } from '@rpc/client';

const resp = await marketIngestion.snapshot('RELIANCE', {
  correlationId,
  serviceAuthToken: process.env.SERVICE_AUTH_TOKEN,
});
```

All calls have: 2s timeout, 3 attempts with exponential backoff,
automatic correlation id, and typed ServiceResponse envelopes.

### Health endpoint (mandatory)

Every service exposes `GET /health` returning `HealthResponse`
(see `packages/contracts/src/api.ts`). The response includes
dependency status so the gateway can degrade gracefully.

---

## What blocks Services 2–6

Per the Priority 0 architecture freeze:

- [ ] **Phase 1 Tier 0** — every direct IndianAPI / Yahoo / Kite call
      migrated to `MarketDataProvider`. `MarketDataProvider` itself
      no longer touches Kite; Kite is broker/execution only.
      See `MIGRATION_PLAYBOOK.md` Tier 0 for the remaining files.
- [ ] **Phase 2 data migration** — the `snapshotRepo` needs rows in
      `market.snapshots_current` before the DB fallback is useful.
      Run `npm run db:migrate:pg` to create schemas, then backfill.
- [ ] **Postgres-only reads** — no remaining runtime import of
      `@/lib/db` in service modules extracted to this workspace.

Once both clear, Services 2–6 follow the same pattern this PR
establishes:

1. New folder under `services/`
2. New route entries in `packages/contracts/src/api.ts` → `SERVICES`
3. New typed client in `packages/rpc/src/client.ts`
4. New event names in `packages/contracts/src/events.ts`

---

## Env vars added

```
INDIAN_API_KEY=                                 # (aliases INDIANAPI_KEY)
INDIAN_API_BASE_URL=https://stock.indianapi.in  # (aliases INDIANAPI_BASE_URL)
YAHOO_ENABLED=true
MARKET_INGESTION_PORT=4100
# MARKET_INGESTION_URL=http://market-ingestion.internal:4100
SERVICE_AUTH_TOKEN=dev-only-rotate-me
```

`SERVICE_AUTH_TOKEN` is required in production (config throws at
startup if `NODE_ENV=production` and the token is missing).
