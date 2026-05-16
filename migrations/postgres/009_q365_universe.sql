-- ════════════════════════════════════════════════════════════════
--  q365_universe — DB-backed tradeable universe (NIFTY 500 default)
--
--  Replaces the static `nseUniverse.json` (~2,767 symbols) with a
--  curated list — by default NIFTY 500. Keeping the universe in DB
--  lets `scripts/loadNifty500.ts` rebuild on each index review
--  without a code redeploy, and lets ops mark a symbol inactive
--  without dropping rows (preserves audit history for past trades).
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS q365_universe (
  id            SERIAL PRIMARY KEY,
  symbol        VARCHAR(32) NOT NULL UNIQUE,
  company_name  VARCHAR(255) NOT NULL,
  isin          VARCHAR(16),
  sector        VARCHAR(64),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_q365_universe_active
  ON q365_universe (is_active);

-- Symbol-mapping override table — populated only when the upstream
-- IndianAPI rejects an NSE symbol with the default mapping. See
-- src/lib/marketData/symbolMapper.ts for the lookup chain.
CREATE TABLE IF NOT EXISTS q365_symbol_mapping_override (
  nse_symbol  VARCHAR(32) PRIMARY KEY,
  api_symbol  VARCHAR(32) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

-- ── DOWN ────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS q365_symbol_mapping_override;
-- DROP TABLE IF EXISTS q365_universe;
