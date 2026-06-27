-- ════════════════════════════════════════════════════════════════
--  Migration 032 — Public Signal Ledger (MySQL)
--
--  One-row-per-signal outcome records. Does NOT ALTER q365_signals.
--
--  Apply (idempotent):
--    npm run db:migrate-signal-outcomes
--    npx tsx scripts/applySignalOutcomesPublicMigration.ts
--
--  Safe rules:
--    - CREATE TABLE IF NOT EXISTS for greenfield installs
--    - Additive ALTER for legacy q365_signal_outcomes shapes
--    - Never DROP legacy columns
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS q365_signal_outcomes (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  signal_id           BIGINT       NOT NULL,
  strategy_id         VARCHAR(64)  NOT NULL,
  symbol              VARCHAR(64)  NOT NULL,
  outcome             VARCHAR(24)  NOT NULL,
  outcome_at          DATETIME     NOT NULL,
  days_held           INT          NOT NULL DEFAULT 0,
  max_gain_pct        DECIMAL(10,4) DEFAULT NULL,
  candle_check_count  INT          NOT NULL DEFAULT 0,
  resolved_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_q365_signal_outcomes_signal (signal_id),
  INDEX idx_q365_signal_outcomes_strategy_outcome (strategy_id, outcome),
  INDEX idx_q365_signal_outcomes_outcome_at (outcome_at),
  CONSTRAINT fk_q365_signal_outcomes_signal
    FOREIGN KEY (signal_id) REFERENCES q365_signals (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
