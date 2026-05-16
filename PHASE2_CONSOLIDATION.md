# Phase 2 Consolidation — What Shipped, What's Left

Companion to `MIGRATION_PLAYBOOK.md`. This doc covers the
consolidation batch: provider enforcement, dual-write, feature
flag, and live-data validation. MySQL is still authoritative and
the existing UI is unchanged.

---

## Files delivered in this batch

```
src/lib/marketData/enforcer.ts              ← AsyncLocalStorage tripwire
src/providers/MarketDataProvider.ts         ← wrapped adapter calls + USE_POSTGRES flag
src/services/LiveQuoteService.ts            ← + persistSnapshot, fetchAndPersist
src/services/repos/dualWriteSnapshotRepo.ts ← PG always, MySQL opt-in
scripts/validateData.ts                     ← live snapshot diff (MySQL ↔ PG)
```

Plus the already-shipped:
- `migrations/postgres/008_fix_schema_drift.sql`
- `scripts/validatePg.ts`

---

## Environment variables added

| Var | Effect | Default |
|---|---|---|
| `ENFORCE_PROVIDER` | `off` \| `warn` \| `throw` — tripwire mode | `off` |
| `USE_POSTGRES` | read `market.snapshots_current` BEFORE Yahoo | `false` |
| `MYSQL_DUAL_WRITE_TABLE` | enables best-effort MySQL dual-write | unset (disabled) |
| `MYSQL_DUAL_WRITE_SQL` | override the default MySQL UPSERT SQL | unset |

**Read `.env.local` once you've decided the target MySQL table.**
The default SQL in `dualWriteSnapshotRepo` assumes columns
`symbol, price, prev_close, change, change_percent, open, high,
low, volume, source, data_quality, fetched_at, updated_at`. If your
chosen table has different column names, override via
`MYSQL_DUAL_WRITE_SQL`.

---

## The enforcer — how it works, how to wire it

### Already wired

`MarketDataProvider.ts` calls `withProviderFrame(...)` around every
IndianAPI and Yahoo adapter invocation. Anything downstream of
those adapter calls is automatically "authorized."

### Needs wiring (one line each)

Add this at the top of each legacy function:

```ts
import { assertProviderFrame } from '@/lib/marketData/enforcer';

export async function fetchFromYahoo(symbol: string) {
  assertProviderFrame('fetchFromYahoo');
  // ... existing body unchanged
}
```

Priority list (wire in THIS order — each is one line):

1. `src/lib/marketData/yahoo.ts` → `fetchFromYahoo`
2. `src/lib/marketData/priceCache.ts` → `fetchFromYahooCached`
3. `src/lib/marketData/MarketDataResolver.ts` → `resolvePrice`
4. `src/lib/marketData/getLivePrice.ts` → exported `getLivePrice`
5. `src/lib/marketData/yahooFallbackPoller.ts` → poller start fn

### Modes

```bash
# development default — no visible effect
ENFORCE_PROVIDER=off   npm run dev

# development with surfacing — prints every bypass to stderr with stack
ENFORCE_PROVIDER=warn  npm run dev

# CI / tests — fail on any direct call
ENFORCE_PROVIDER=throw npm test
```

The `getViolations()` helper (exported from `enforcer.ts`) returns
the current per-api counter, for use in health dashboards or
test assertions.

---

## The Kite gap — RESOLVED (Option B)

**Decision (Priority 0 architecture freeze):** Kite is **broker /
execution only**. `MarketDataProvider` does not include a KiteAdapter
in its chain. Live market-data truth is `IndianAPI → Cache → Yahoo →
PostgreSQL`.

Consequences, now implemented:

- `MarketDataProvider.getLiveSnapshot` has NO Kite step. The
  `KiteAdapter` file remains on disk but is unreferenced by the
  provider module.
- `src/lib/marketData/MarketDataResolver.ts`, `getLivePrice.ts`,
  `kiteTicker.ts`, and the Kite bootstrap path are scheduled for
  deprecation in Tier 0 of the migration playbook. Callers migrate
  to `MarketDataProvider.getLiveSnapshot`.
- `src/lib/execution/*` continues to use Kite for order placement,
  broker callbacks, and session management — that is its only
  supported role.
- Enforcer can safely reach `ENFORCE_PROVIDER=throw` once the Tier 0
  refactor lands and every legacy helper wears an
  `assertProviderFrame` guard.

---

## `USE_POSTGRES` read flag — what it does

Inside `MarketDataProvider.getLiveSnapshot`:

```
flag = off (default)             flag = on
1. IndianAPI                     1. IndianAPI
2. cache (10 min)                2. cache (10 min)
3. Yahoo                         3. Postgres (snapshots_current)
4. Postgres                      4. Yahoo
                                 5. Postgres  (skipped — already tried)
```

Rationale: once the scheduler populates `market.snapshots_current`,
hitting Yahoo for every cache miss is wasteful. Flipping the flag
makes PG the cheap second-chance read. Signal-critical callers
still reject `source='db'`, so quality is preserved.

Enable when:
- Phase-2 scheduler has been running for 24h
- `npm run db:check:pg` shows `market.snapshots_current` has rows
- Validation script (`db:validate:data`) returns zero mismatches

---

## Dual-write — how to enable

1. Identify the MySQL table you want snapshots mirrored to (it may be
   a new table — create it first).
2. Set in `.env.local`:
   ```
   MYSQL_DUAL_WRITE_TABLE=my_snapshots_current
   ```
3. (Optional) Override the default MySQL UPSERT if your column names
   differ:
   ```
   MYSQL_DUAL_WRITE_SQL="INSERT INTO my_snapshots_current (sym, ltp, ...) VALUES (?, ?, ...) ON DUPLICATE KEY UPDATE ..."
   ```
4. Wherever your code currently writes a quote to MySQL, swap to
   `LiveQuoteService.persistSnapshot(resp)` or
   `LiveQuoteService.fetchAndPersist(symbol)`. Both will now write
   to PG (authoritative) + MySQL (best-effort).

---

## Validation workflow

```bash
# 1. Confirm schema is complete
npm run db:check:pg

# 2. Confirm UPSERT + TIMESTAMPTZ + JSONB round-trip work
npm run db:check:pg:insert

# 3. After the scheduler has populated both DBs for an hour:
npm run db:validate:data -- --since=60m

# Per-symbol drilldown
npm run db:validate:data -- --symbol=RELIANCE
```

Exit code 0 = matched, 1 = mismatches, 2 = config/connectivity.

---

## Definition of "consolidation done"

- [ ] Kite gap resolved (Option A or B above)
- [ ] Enforcer wired into the 5 legacy files (one line each)
- [ ] `ENFORCE_PROVIDER=warn` in staging shows zero bypass counts for
      48 hours
- [ ] `MYSQL_DUAL_WRITE_TABLE` configured; both DBs receiving writes
- [ ] `npm run db:validate:data` returns 0 failures for 48 hours
- [ ] `USE_POSTGRES=true` in production; Yahoo hit rate drops as
      expected
- [ ] Only then: flip `ENFORCE_PROVIDER=throw` in production

Until every box is checked, the foundation is load-bearing but
**consolidation is incomplete**. That's the current state.


## IndianAPI smoke-test snippets

Replace `$INDIAN_API_KEY` with your key. **Never commit keys to this file.**

```bash
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/NSE_most_active"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/trending"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/stock?name=RELIANCE"
```