-- ════════════════════════════════════════════════════════════════
--  Rollback — undo migrations 001–008
--
--  ⚠  DESTRUCTIVE. This drops every table/schema/extension created
--    by the Phase-2 migration batch, in reverse dependency order.
--    Run only when:
--      • The migration went wrong and you want a clean slate.
--      • OR you're decommissioning the Postgres side and going back
--        to MySQL-only.
--
--  This file is NOT run by `npm run db:migrate:pg` — it's executed
--  manually with psql:
--
--     psql "$POSTGRES_URL" -f migrations/postgres/_rollback.sql
--
--  After rollback:
--    • ops._migrations is dropped too, so re-running the migrator
--      re-applies all 8 migrations from scratch.
--    • Any data in those tables is GONE — dump first if needed:
--        pg_dump -Fc --schema=market --schema=intel "$POSTGRES_URL" > backup.dump
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- Sanity guard: refuse to run unless the caller exported
--   ALLOW_ROLLBACK=1
-- This prevents accidental execution via a stray \i include.
DO $$
BEGIN
  IF current_setting('rollback.allow', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION
      'Rollback not authorized. Run psql with: -v rollback.allow=1';
  END IF;
END $$;

-- ── app schema ──────────────────────────────────────────────────────
DROP TABLE IF EXISTS app.reports                CASCADE;
DROP TABLE IF EXISTS app.alerts                 CASCADE;
DROP TABLE IF EXISTS app.portfolio_holdings     CASCADE;
DROP TABLE IF EXISTS app.portfolios             CASCADE;
DROP TABLE IF EXISTS app.watchlists             CASCADE;

-- ── intel schema ────────────────────────────────────────────────────
DROP TABLE IF EXISTS intel.statements           CASCADE;
DROP TABLE IF EXISTS intel.target_prices        CASCADE;
DROP TABLE IF EXISTS intel.forecasts            CASCADE;
DROP TABLE IF EXISTS intel.announcements        CASCADE;
DROP TABLE IF EXISTS intel.corporate_events     CASCADE;
DROP TABLE IF EXISTS intel.news                 CASCADE;

-- ── market schema (partitioned parents cascade to children) ─────────
DROP TABLE IF EXISTS market.historical_stats       CASCADE;
DROP TABLE IF EXISTS market.candles                CASCADE;
DROP TABLE IF EXISTS market.snapshots_intraday     CASCADE;
DROP TABLE IF EXISTS market.snapshots_current      CASCADE;

-- ── master schema ───────────────────────────────────────────────────
DROP TABLE IF EXISTS master.symbol_aliases      CASCADE;
DROP TABLE IF EXISTS master.instruments         CASCADE;
DROP TABLE IF EXISTS master.industries          CASCADE;
DROP TABLE IF EXISTS master.sectors             CASCADE;

-- ── auth schema ─────────────────────────────────────────────────────
DROP TABLE IF EXISTS auth.audit_logs            CASCADE;
DROP TABLE IF EXISTS auth.sessions              CASCADE;
DROP TABLE IF EXISTS auth.users                 CASCADE;

-- ── ops schema ──────────────────────────────────────────────────────
DROP TABLE IF EXISTS ops.audit_raw_payloads     CASCADE;
DROP TABLE IF EXISTS ops.dead_letter_events     CASCADE;
DROP TABLE IF EXISTS ops.provider_health_logs   CASCADE;
DROP TABLE IF EXISTS ops.scheduler_runs         CASCADE;
DROP TABLE IF EXISTS ops._migrations            CASCADE;

-- ── schemas themselves (empty, so safe to drop) ─────────────────────
DROP SCHEMA IF EXISTS app    CASCADE;
DROP SCHEMA IF EXISTS intel  CASCADE;
DROP SCHEMA IF EXISTS market CASCADE;
DROP SCHEMA IF EXISTS master CASCADE;
DROP SCHEMA IF EXISTS auth   CASCADE;
DROP SCHEMA IF EXISTS ops    CASCADE;

-- ── extensions are shared across databases; leave them in place ────
-- We do NOT drop pgcrypto or citext because other databases on the
-- same cluster may use them. If you need to, drop manually.

COMMIT;
