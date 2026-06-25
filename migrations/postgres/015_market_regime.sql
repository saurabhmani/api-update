-- Canonical market_regime table (Trust Layer)
-- Regime is computed from benchmark candles before signal generation runs.

CREATE TABLE IF NOT EXISTS market_regime (
  id               BIGSERIAL PRIMARY KEY,
  regime_label     VARCHAR(64)  NOT NULL,
  regime_category  VARCHAR(32)  NOT NULL,
  benchmark_symbol VARCHAR(32)  NOT NULL DEFAULT 'NIFTY 50',
  strength         NUMERIC(6,2) NOT NULL DEFAULT 0,
  confidence       NUMERIC(6,2) NOT NULL DEFAULT 0,
  allow_bullish    BOOLEAN      NOT NULL DEFAULT FALSE,
  confidence_modifier NUMERIC(6,2) NOT NULL DEFAULT 0,
  details_json     JSONB,
  computed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_regime_computed
  ON market_regime (computed_at DESC);

-- Logical inventory (physical tables):
--   signals         → q365_signals
--   signal_reasons  → q365_signal_reasons (reason_type = 'reason')
--   signal_warnings → q365_signal_reasons (reason_type = 'warning')
--   watchlists      → watchlists + watchlist_items
