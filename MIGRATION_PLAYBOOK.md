# Quantorus365 — MySQL → PostgreSQL Migration Playbook

**Architecture freeze (Priority 0):** PostgreSQL is the **only** target
runtime database. MySQL survives only as a one-way source for the
Phase-2 backfill, after which the `@/lib/db` shim, `mysql2`, and the
SQL-dialect translation layer are removed.

**Status:** Foundation complete. Parallel-DB phase — **MySQL is still
authoritative in legacy runtime files** until each is migrated to the
`@/lib/db/postgres` access layer. No new code may import `@/lib/db`.

This document is the operational guide for migrating the remaining
MySQL touchpoints onto the PostgreSQL foundation. It is meant to be
read end-to-end by the engineer executing the cutover.

---

## 0. Prerequisites (do these first, in order)

```bash
# 1. Install the Postgres client. This is the ONLY dependency change
#    Phase 2 requires. No code in this PR touched package.json.
npm install pg @types/pg

# 2. Register the migration runner. Add this to package.json scripts:
#      "db:migrate:pg": "tsx src/lib/db/postgres/migrate.ts"

# 3. Set env vars (preferred form):
#      POSTGRES_URL=postgresql://user:pass@host:5432/quantorus365
#    Or discrete:
#      PGHOST=...  PGUSER=...  PGPASSWORD=...  PGDATABASE=...  PGPORT=5432

# 4. Provision a Postgres 14+ instance and run migrations:
npm run db:migrate:pg
```

**Verify:** The runner creates `ops._migrations` and prints
`applied=7 drift=0`. Re-running should print `applied=0 drift=0`.

---

## 1. Foundation delivered in this PR (already merged — do not rebuild)

```
src/lib/db/postgres.ts                 ← pg Pool + pg.query/pg.tx
src/lib/db/postgres/migrate.ts         ← versioned, idempotent runner
migrations/postgres/
   001_create_schemas.sql              ← auth/master/market/intel/app/ops
   002_auth.sql                        ← users, sessions, audit_logs
   003_master.sql                      ← instruments, aliases, sectors
   004_market.sql                      ← snapshots_current + partitioned series
   005_intel.sql                       ← news, events, forecasts, targets
   006_app.sql                         ← watchlists, portfolios, alerts
   007_ops.sql                         ← scheduler_runs, provider_health
src/services/repos/snapshotRepo.ts     ← REFERENCE upsert + read
src/app/api/market/snapshot-db/route.ts ← REFERENCE pg-only API
src/scripts/validateMysqlVsPostgres.ts ← row counts + ts range + SUM
```

**Not changed (intentionally):** `src/lib/db.ts`, `src/lib/db/` MySQL
migration files, `package.json`, any existing service, or any running
code path. The app still reads and writes MySQL exclusively.

---

## 2. Migration order — strict tiers

Files are migrated **tier by tier**. Do not start tier N+1 until tier N
is fully validated in production for at least 48 hours. "Validated"
means the validation script (§6) is clean for the tier's table
mappings.

### Tier 0 — BLOCKING (Phase-1 cleanup)

The architecture freeze states: *every market-data read flows through
`MarketDataProvider`; direct vendor calls from engines/routes/services
are contract violations.* These files still bypass the provider and
must be routed through it FIRST, in a separate PR, before any Postgres
work lands.

| File | Current behavior | Target |
|---|---|---|
| `src/lib/marketData/MarketDataResolver.ts` | direct Kite + Yahoo | delegate to `MarketDataProvider.getLiveSnapshot` |
| `src/lib/marketData/getLivePrice.ts` | direct Kite + Yahoo | delegate to `MarketDataProvider.getLiveSnapshot` |
| `src/lib/marketData/yahooFallbackPoller.ts` | direct Yahoo | delete (Yahoo is only reachable via provider now) |
| `src/lib/marketData/priceCache.ts` | direct Yahoo cache | delegate to `MarketDataProvider` + `src/lib/cache.ts` |
| `src/services/marketQuote.ts` | calls resolver directly | `MarketDataProvider.getQuote` |
| `src/services/marketDataService.ts` | calls Yahoo helpers | `MarketDataProvider` for reads; persistence stays local |
| `src/services/dataAggregator.ts` | mixed direct calls | `MarketDataProvider` for every snapshot |
| `src/lib/workers/scheduler.ts` | mixed Kite/Yahoo direct calls + `@/lib/db` | delegate to `src/lib/scheduler.ts` (IST 10-min cadence) |
| `src/app/api/signals/route.ts` | calls resolver directly | `MarketDataProvider.getLiveSnapshot({ signalCritical: true })` |

**Action:** Route all of these through `MarketDataProvider`. The
provider now enforces the canonical chain `IndianAPI → Cache → Yahoo
→ PostgreSQL` with a full `ProviderResponse` envelope
(`provider_name`, `source_type`, `vendor_timestamp`, `freshness_ms`,
`fallback_reason`, `data_quality`). **Kite is not in the market-data
chain** — it is retained only in `src/lib/execution/*` for order
placement and broker callbacks.

### Tier 1 — Ops & audit (lowest risk, append-only)

Append-only writes are the safest first migration: no UPSERT logic,
no read paths to break.

| Table group | Files to migrate |
|---|---|
| `ops.scheduler_runs` | `src/lib/workers/scheduler.ts`, `src/lib/workers/learningScheduler.ts`, `src/lib/workers/manipulationScanner.ts`, `src/lib/workers/newsIngestionScheduler.ts`, `src/lib/scheduler.ts` |
| `ops.provider_health_logs` | `src/providers/resilience.ts` (add insert hook), `src/app/api/health/route.ts`, `src/app/api/monitor/run-checks/route.ts` |
| `ops.dead_letter_events` | `src/lib/news-engine/feedback/linkageTracker.ts`, `src/services/auditLogService.ts` |
| `ops.audit_raw_payloads` | both adapters (`IndianAPIAdapter`, `YahooAdapter`) — optional tee on success path |

### Tier 2 — Master data (read-heavy, low write volume)

| Table | Files |
|---|---|
| `master.instruments` | `src/services/instrumentResolver.ts`, `src/lib/marketData/kiteInstruments.ts`, `src/app/api/instruments/route.ts`, `src/services/canonicalDataService.ts` |
| `master.symbol_aliases` | `src/lib/marketData/symbolNormalize.ts`, `src/services/instrumentResolver.ts` |
| `master.sectors` / `master.industries` | `src/services/canonicalDataService.ts`, sector-aware services |

### Tier 3 — Market data (high write volume, MUST be perfect)

Migrate snapshots_current before candles — snapshots have in-place
UPSERT and are drift-resistant; candles are append-only but large.

| Table | Files |
|---|---|
| `market.snapshots_current` | `src/services/marketQuote.ts`, `src/services/marketDataService.ts`, `src/app/api/market/route.ts`, `src/app/api/market-data/reseed/route.ts`, `src/app/api/ticker/route.ts` |
| `market.snapshots_intraday` | `src/lib/marketData/candleIngest.ts`, `src/lib/marketData/priceCache.ts` |
| `market.candles` | `src/lib/marketData/candleIngest.ts`, `src/lib/backtesting/data/historicalCandleProvider.ts`, `src/lib/backtesting/data/seedHistoricalData.ts`, `src/lib/manipulation-engine/data/candleLoader.ts`, `src/lib/signal-engine/live/candleFreshnessGuard.ts`, `src/lib/signal-engine/live/analyzeInstrument.ts` |
| `market.historical_stats` | `src/services/chartService.ts`, `src/lib/db/queries/chartQueries.ts` |

**Partitioning action:** schedule a nightly job that runs
```sql
CREATE TABLE market.snapshots_intraday_YYYY_MM_DD
  PARTITION OF market.snapshots_intraday
  FOR VALUES FROM ('YYYY-MM-DD') TO ('YYYY-MM-DD'::date + 1);
```
for the next 7 days. Default partition covers misses.

### Tier 4 — Intelligence (news, corporate events)

| Table | Files |
|---|---|
| `intel.news` | `src/lib/news-engine/repository/saveNewsEvents.ts`, `src/lib/news-engine/repository/readNewsEvents.ts`, `src/lib/news-engine/repository/ensureNewsSchemas.ts`, `src/app/api/news/route.ts`, `src/app/api/news/categories/route.ts`, `src/services/newsService.ts` |
| `intel.corporate_events` | `src/services/marketIntelligenceService.ts`, `src/lib/news-engine/impact/computeImpact.ts` |
| `intel.forecasts` / `intel.target_prices` / `intel.statements` | `src/services/valuationService.ts`, `src/services/stockDetailService.ts` |

### Tier 5 — App (user-facing — requires read-then-write cutover)

This tier is the highest risk because end-user data lives here. Follow
the dual-write pattern described in §4.

| Table | Files |
|---|---|
| `auth.users` / `auth.sessions` | `src/services/auth.ts`, `src/services/entitlement.ts`, `src/lib/db/seedUsers.ts`, `src/app/api/user/route.ts`, `src/app/api/user/onboarding/route.ts`, `src/app/api/user/features/route.ts` |
| `auth.audit_logs` | `src/services/auditLogService.ts`, `src/services/governanceService.ts` |
| `app.watchlists` | `src/app/api/watchlist/route.ts`, `src/app/api/watchlist/intelligence/route.ts` |
| `app.portfolios` / `app.portfolio_holdings` | `src/services/portfolioLedgerService.ts`, `src/services/pnlService.ts`, `src/services/performanceTracker.ts`, `src/app/api/portfolio/*` |
| `app.alerts` | `src/services/alertService.ts`, `src/services/alertsEngine.ts`, `src/app/api/alerts/route.ts`, `src/app/api/alerts/breaches/route.ts` |
| `app.reports` | `src/app/api/reports/route.ts` |

### Tier 6 — Signal engine (migrate LAST)

The signal engine has the most complex transactional workflows
(multi-table inserts under a single logical operation). Wait until
every upstream table it reads from is on Postgres before moving its
writes.

| Files |
|---|
| `src/lib/signal-engine/repository/saveSignals.ts` |
| `src/lib/signal-engine/repository/savePhase3Signals.ts` |
| `src/lib/signal-engine/repository/savePhase4Artifacts.ts` |
| `src/lib/signal-engine/repository/saveStrategyBreakdowns.ts` |
| `src/lib/signal-engine/repository/saveLearningArtifacts.ts` |
| `src/lib/signal-engine/repository/readSignals.ts` |
| `src/lib/signal-engine/repository/ensureSchemas.ts` |
| `src/app/api/signal-engine/*` (11 routes) |
| `src/app/api/signals/*` (3 routes) |
| `src/app/api/run-signal-engine/route.ts` |
| `src/app/api/trade-setups/route.ts` |
| `src/app/api/trade-journal/route.ts` |
| `src/services/tradeSetupGenerator.ts` |
| `src/services/scenarioEngine.ts`, `scenarioStressService.ts` |
| `src/services/decisionOrchestrator.ts`, `decisionTraceBuilder.ts` |
| `src/services/marketStanceEngine.ts`, `opportunityService.ts` |
| `src/services/riskCoreService.ts`, `portfolioFitService.ts`, `institutionalFitService.ts` |
| `src/services/deterministicLedger.ts`, `preTradeGatewayService.ts` |
| `src/lib/execution/*` (schema + persistence) |
| `src/lib/backtesting/*` (entire tree) |
| `src/lib/manipulation-engine/*` (entire tree) |

---

## 3. Per-file migration recipe

For each file in a tier:

1. **Swap the import** — replace
   ```ts
   import { db } from '@/lib/db';
   ```
   with
   ```ts
   import { pg as db } from '@/lib/db/postgres';
   ```
   Aliasing as `db` means nothing else in the file changes in step 1.

2. **Rewrite dialect-specific SQL** (grep for these in the file):
   | MySQL | Postgres |
   |---|---|
   | `ON DUPLICATE KEY UPDATE col=VALUES(col)` | `ON CONFLICT (…) DO UPDATE SET col = EXCLUDED.col` |
   | `?` placeholders | `$1, $2, …` |
   | `DATETIME` column type | `TIMESTAMPTZ` (already in migrations) |
   | `TINYINT(1)` | `BOOLEAN` |
   | `JSON` (TEXT) | `JSONB` |
   | ``INSERT INTO `t` SET a=?, b=?`` | `INSERT INTO t (a,b) VALUES ($1,$2)` |
   | ``SELECT ... LIMIT ? OFFSET ?`` | same — no change |
   | ``DATE_SUB(NOW(), INTERVAL 7 DAY)`` | `NOW() - INTERVAL '7 days'` |
   | ``IFNULL(x, y)`` | `COALESCE(x, y)` |
   | ``GROUP_CONCAT(col)`` | `STRING_AGG(col::text, ',')` |
   | ``UNIX_TIMESTAMP(ts)`` | `EXTRACT(EPOCH FROM ts)::bigint` |
   | ``FROM_UNIXTIME(ms/1000)`` | `to_timestamp(ms/1000.0)` |
   | ``LIKE`` (case-insensitive by default collation) | `ILIKE` |
   | ``\`col\``` (backtick-quoted) | `"col"` (double-quoted, preserve case) |
   | ``LAST_INSERT_ID()`` / `header.insertId` | `INSERT … RETURNING id` |

3. **Run unit tests** for the file. If there are none, write one now.

4. **Dual-write for a week** (see §4) before deleting the MySQL branch.

---

## 4. Dual-write cutover pattern for high-risk tables

For Tier 5 (user-facing) and Tier 6 (signal engine), do NOT flip a
single switch. Use feature-flag guarded dual-write:

```ts
if (process.env.PG_WRITE_ENABLED === 'true') {
  await pgRepo.write(...);   // new path
}
await mysqlRepo.write(...);  // old path — still authoritative
```

After 48h of clean dual-writes + the validation script passing:

```ts
if (process.env.PG_READ_ENABLED === 'true') {
  return pgRepo.read(...);   // flip reads to PG
}
return mysqlRepo.read(...);
```

After another 48h, remove the MySQL branch. At that point the file is
"done."

---

## 5. Wiring the Phase-1 DB fallback

The Phase-1 MarketDataProvider has a DB tier that today throws
`StaleDataError` because no repo is registered. To close that gap
after snapshots start flowing into Postgres:

```ts
// in instrumentation.ts / server.js boot
import { registerOnMarketDataProvider } from '@/services/repos/snapshotRepo';
registerOnMarketDataProvider();
```

Do this ONLY after Tier 3 is validated. Until then the stale
fallback remains unreachable, which is correct — a repo wired to an
empty table would lie.

---

## 6. Validation workflow

Run after each tier:

```bash
tsx src/scripts/validateMysqlVsPostgres.ts
tsx src/scripts/validateMysqlVsPostgres.ts --table=market.snapshots_current
```

Expand `TABLE_MAPPINGS` in the script as you move each pair over.
Zero failures for 48 hours = tier done.

---

## 7. Rollback

Every tier is reversible until the MySQL branch is deleted.

| State | Rollback |
|---|---|
| Migrations applied, no code using pg | Drop the Postgres DB — no app change |
| Dual-write, PG reads OFF | Set `PG_WRITE_ENABLED=false`, restart |
| PG reads ON | Set `PG_READ_ENABLED=false`, restart |
| MySQL branch deleted | **non-reversible** — only proceed after 7 days of clean dual-reads |

There is no rollback for schema-drift edits (editing a migration
after it's applied). Always add a new numbered migration — the runner
will warn about checksum drift and exit 2 if you try.

---

## 8. Done definition for Phase 2

Phase 2 is "done" when **all** of the following are true:

- [ ] Tier 0 complete (every market-data call goes through MarketDataProvider)
- [ ] Tiers 1–6 migrated, dual-write windows observed, MySQL branches removed
- [ ] `src/lib/db.ts` deleted; no imports from it anywhere in `src/**`
- [ ] `mysql2` removed from `package.json`
- [ ] `MYSQL_*` env vars removed from `.env*` and deployment configs
- [ ] `src/lib/db/migrations/` (MySQL) archived into `docs/archive/`
- [ ] The validation script returns zero failures for 7 consecutive days

Until every box is checked, Postgres is a parallel system, not a
replacement.
