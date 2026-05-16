-- ════════════════════════════════════════════════════════════════
--  master schema — instrument universe, aliases, taxonomy
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS master.sectors (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS master.industries (
  id          SERIAL      PRIMARY KEY,
  sector_id   INTEGER     REFERENCES master.sectors(id) ON DELETE SET NULL,
  name        TEXT        UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_industries_sector ON master.industries (sector_id);

CREATE TABLE IF NOT EXISTS master.instruments (
  symbol          TEXT        PRIMARY KEY,  -- canonical NSE symbol
  isin            TEXT        UNIQUE,
  exchange        TEXT        NOT NULL DEFAULT 'NSE',
  instrument_type TEXT        NOT NULL DEFAULT 'EQ',
  company_name    TEXT        NOT NULL,
  sector_id       INTEGER     REFERENCES master.sectors(id) ON DELETE SET NULL,
  industry_id     INTEGER     REFERENCES master.industries(id) ON DELETE SET NULL,
  lot_size        INTEGER     NOT NULL DEFAULT 1,
  tick_size       NUMERIC(12,4) NOT NULL DEFAULT 0.05,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instruments_active   ON master.instruments (is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_instruments_sector   ON master.instruments (sector_id);
CREATE INDEX IF NOT EXISTS idx_instruments_industry ON master.instruments (industry_id);
CREATE INDEX IF NOT EXISTS idx_instruments_type     ON master.instruments (instrument_type);

-- symbol_aliases carries vendor-specific or legacy tickers mapped
-- back to the canonical `instruments.symbol`.
CREATE TABLE IF NOT EXISTS master.symbol_aliases (
  alias       TEXT        NOT NULL,
  symbol      TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  source      TEXT        NOT NULL,     -- 'yahoo' | 'indian' | 'bse' | ...
  is_primary  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alias, source)
);

CREATE INDEX IF NOT EXISTS idx_aliases_symbol ON master.symbol_aliases (symbol);

COMMIT;
