-- Rollback: Quant Intelligence Platform (migration 031)
-- Run manually:
--   psql "$POSTGRES_URL" -v rollback.allow=1 -f migrations/postgres/031_quant_platform_rollback.sql

BEGIN;

DO $$
BEGIN
  IF current_setting('rollback.allow', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Rollback not authorized. Run psql with: -v rollback.allow=1';
  END IF;
END $$;

DROP TABLE IF EXISTS quant.api_keys           CASCADE;
DROP TABLE IF EXISTS quant.api_clients        CASCADE;
DROP TABLE IF EXISTS quant.enterprise_reports CASCADE;
DROP TABLE IF EXISTS quant.event_risk_scores  CASCADE;
DROP TABLE IF EXISTS quant.sentiment_scores     CASCADE;
DROP TABLE IF EXISTS quant.portfolio_allocations CASCADE;
DROP TABLE IF EXISTS quant.strategy_recommendations CASCADE;
DROP TABLE IF EXISTS quant.research_reports   CASCADE;

COMMIT;
