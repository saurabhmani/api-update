# IndianAPI Rollout and Rollback

Staged, feature-flagged activation of IndianAPI as the system
warehouse provider. Code ships dark; every stage is env-only — no
deploys, no schema changes, instant rollback.

Data flow when active:
`IndianAPI → ingestion orchestrator → Redis + MySQL/PostgreSQL → MarketDataProvider → clients`

## Flags that control the rollout

| Variable | Role |
|----------|------|
| `INDIANAPI_ENABLED` | Master feature flag. `false` = all IndianAPI ingestion refuses to run (loud config error if invoked). |
| `INDIANAPI_API_KEY` | Credentials. Required for selection or bootstrap default. |
| `MARKET_DATA_PROVIDER` | Explicit provider selection always wins. **Unset** + flag on + key present → bootstrap default `indianapi`. |
| `INDIANAPI_INGEST_SYMBOL_LIMIT` | Staged universe subset (`20` → `100` → `500` → `0` = full). |
| `INDIANAPI_RPS_GLOBAL`, `INDIANAPI_MAX_CONCURRENCY`, `INDIANAPI_DAILY_SOFT_LIMIT`, `INDIANAPI_MONTHLY_LIMIT` | Plan-tuned budget knobs (see `docs/PROVIDER_REQUEST_POLICY.md`). |

## Stage 0 — Ship dark

- Deploy with `INDIANAPI_ENABLED=false` (or unset). Nothing runs; no
  behavior change anywhere.
- `ensureAllSchemas` creates `indianapi_ingestion_runs` /
  `indianapi_symbol_sync_state` idempotently — harmless while dark.

## Stage 1 — Dev smoke (20 symbols)

```bash
INDIANAPI_ENABLED=true
INDIANAPI_API_KEY=<dev key>
MARKET_DATA_PROVIDER=indianapi
INDIANAPI_INGEST_SYMBOL_LIMIT=20
```

Verify:

1. `npx tsx scripts/verifyIndianApiEndpoints.ts` — confirms which
   endpoints exist on the plan host (batch route is plan-dependent).
2. One quote-ingestion tick logs `[INDIANAPI_INGEST]` with
   `processed=20 failed=0`; `quote:<SYMBOL>` keys appear in Redis and
   snapshot rows carry `source='indianapi'`.
3. Overlap safety: trigger two runs concurrently — the second logs
   `overlap_skipped`.
4. Client reads (`getLiveSnapshot`) serve from cache with
   `provider_name='IndianAPI'`-ingested data and **zero** upstream HTTP
   from request paths (`provider_request_logs` shows only
   `source_job` ingestion entries).

## Stage 2 — Staging ramp (100 → 500 → full)

Raise `INDIANAPI_INGEST_SYMBOL_LIMIT` stepwise. At each step watch:

- `institutional_indianapi_rate_limited_total` — 429s should be rare;
  sustained 429s mean `INDIANAPI_RPS_GLOBAL` is above the plan's real
  ceiling. Lower it; do not raise retries.
- `/usage` (vendor-reported) vs `indianapi:usage:day:*` counters —
  they should track within a few percent.
- `institutional_indianapi_quote_sync_age_seconds` — quote staleness
  p95 must stay inside the batch-tier cadence.
- `indianapi_symbol_sync_state` failure counts — a stable dead-letter
  set means symbol-mapping bugs, not transient noise.

Optional shadow comparison: with a Kite token available, log-only
compare IndianAPI LTP vs Kite LTP for a sample; investigate deltas
beyond tolerance before promoting.

## Stage 3 — Data-quality gates (must pass before production)

- Coverage: ≥ 99% of the active universe has a fresh quote after a
  full ingestion cycle.
- Null/zero LTP rate ≈ 0 (mapper drops unusable rows — watch the
  `missing from batch response` dead letters instead).
- Staleness p95 within cadence; no candle gaps vs exchange calendar.
- Budget: full-universe daily cost fits `INDIANAPI_DAILY_SOFT_LIMIT`
  with ≥ 25% headroom.

## Stage 4 — Production

1. Enable the flag but **keep the explicit provider**
   (`MARKET_DATA_PROVIDER=kite`) — ingestion warms the warehouse while
   clients still serve the incumbent path.
2. Once gates pass, switch `MARKET_DATA_PROVIDER=indianapi` — or unset
   it to exercise the bootstrap default.
3. Remove `INDIANAPI_INGEST_SYMBOL_LIMIT` (full universe).

## Rollback (instant, env-only)

```bash
MARKET_DATA_PROVIDER=kite      # or none
INDIANAPI_ENABLED=false
```

- Ingestion jobs no-op (scheduler gates on the flag; direct invocation
  fails loudly with a config error).
- Clients keep serving the last-known cache/DB data; no code or schema
  change required. Tables and `provider_request_logs` history are kept
  for forensics — do **not** drop them.
- Re-enabling later resumes cleanly: checkpoints expire, locks
  self-release (TTL), counters are day-bucketed.

## Invariants enforced in CI (do not regress)

- Architecture freeze: `IndianAPIAdapter` importable only from
  providers/ingestion paths (`architectureFreeze.vitest.ts`).
- Request-path leak scan: `npm run check:provider`
  (`scripts/checkProviderConsistency.ts`).
- Serve-path contract: in indianapi mode MDP never calls Kite/Yahoo
  and throws `StaleDataError` on empty warehouse
  (`indianApiServePath.vitest.ts`).
- Ingestion behavior: locks, checkpoint resume, budget aborts, DLQ
  (`indianApiIngestion.vitest.ts`); adapter error taxonomy and 429
  queue-pause (`indianApiAdapter.vitest.ts`).
