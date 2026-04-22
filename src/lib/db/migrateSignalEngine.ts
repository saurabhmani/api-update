/// <reference types="node" />
// ════════════════════════════════════════════════════════════════
//  Signal Engine — MySQL Migration (Centralized Pipeline)
//
//  Tables:
//    q365_signals                — all generated signals
//    q365_signal_reasons         — reasons & warnings per signal
//    q365_signal_feature_snapshots — feature snapshots for audit
// ════════════════════════════════════════════════════════════════

import { db } from '../db';

const TABLES = [
  // ── Main signals table ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signals (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    instrument_key    VARCHAR(100)  NOT NULL,
    symbol            VARCHAR(50)   NOT NULL,
    exchange          VARCHAR(10)   NOT NULL DEFAULT 'NSE',
    direction         VARCHAR(10)   NOT NULL,
    timeframe         VARCHAR(20)   NOT NULL DEFAULT 'swing',
    signal_type       VARCHAR(50)   NOT NULL,

    confidence_score  INT           NOT NULL,
    confidence_band   VARCHAR(30)   NOT NULL,
    risk_score        INT           NOT NULL,
    risk_band         VARCHAR(30)   NOT NULL,
    opportunity_score INT           NOT NULL DEFAULT 0,
    portfolio_fit_score INT         DEFAULT NULL,
    regime_alignment  INT           DEFAULT NULL,

    entry_price       DECIMAL(12,2) NOT NULL,
    stop_loss         DECIMAL(12,2) NOT NULL,
    target1           DECIMAL(12,2) NOT NULL,
    target2           DECIMAL(12,2) DEFAULT NULL,
    risk_reward       DECIMAL(5,1)  NOT NULL DEFAULT 0.0,

    market_regime     VARCHAR(30)   NOT NULL,
    market_stance     VARCHAR(30)   DEFAULT 'selective',
    scenario_tag      VARCHAR(50)   DEFAULT NULL,

    factor_scores_json JSON         DEFAULT NULL,
    ltp               DECIMAL(12,2) DEFAULT NULL,
    pct_change        DECIMAL(8,2)  DEFAULT NULL,

    status            VARCHAR(20)   NOT NULL DEFAULT 'active',
    batch_id          VARCHAR(50)   DEFAULT NULL,
    generated_at      DATETIME      NOT NULL,
    created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_q365sig_symbol (symbol),
    INDEX idx_q365sig_direction (direction),
    INDEX idx_q365sig_status (status),
    INDEX idx_q365sig_generated (generated_at DESC),
    INDEX idx_q365sig_confidence (confidence_score DESC),
    INDEX idx_q365sig_batch (batch_id),
    INDEX idx_q365sig_opportunity (opportunity_score DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Reasons & Warnings ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_reasons (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id   BIGINT        NOT NULL,
    reason_type VARCHAR(20)   NOT NULL,
    message     TEXT          NOT NULL,
    factor_key  VARCHAR(50)   DEFAULT NULL,
    contribution DECIMAL(5,3) DEFAULT NULL,
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_reasons_signal (signal_id),
    CONSTRAINT fk_reasons_signal FOREIGN KEY (signal_id)
      REFERENCES q365_signals(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Feature Snapshots (audit / backtest) ───────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_feature_snapshots (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id     BIGINT NOT NULL,
    features_json JSON   NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_snapshots_signal (signal_id),
    CONSTRAINT fk_snapshots_signal FOREIGN KEY (signal_id)
      REFERENCES q365_signals(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Trade Plans ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_trade_plans (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    entry_type      VARCHAR(40)    NOT NULL,
    entry_zone_low  DECIMAL(12,2)  NOT NULL,
    entry_zone_high DECIMAL(12,2)  NOT NULL,
    stop_loss       DECIMAL(12,2)  NOT NULL,
    initial_risk_per_unit DECIMAL(12,4) NOT NULL,
    target1         DECIMAL(12,2)  NOT NULL,
    target2         DECIMAL(12,2)  NOT NULL,
    target3         DECIMAL(12,2)  NOT NULL,
    rr_target1      DECIMAL(6,2)   NOT NULL,
    rr_target2      DECIMAL(6,2)   NOT NULL,
    rr_target3      DECIMAL(6,2)   NOT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_tp_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Position Sizing ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_position_sizing (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    capital_model   VARCHAR(30)    NOT NULL,
    portfolio_capital DECIMAL(14,2) NOT NULL,
    risk_budget_pct DECIMAL(6,4)   NOT NULL,
    risk_budget_amount DECIMAL(12,2) NOT NULL,
    initial_risk_per_unit DECIMAL(12,4) NOT NULL,
    position_size_units INT        NOT NULL,
    gross_position_value DECIMAL(14,2) NOT NULL,
    validation_status VARCHAR(20)  NOT NULL,
    warnings_json   JSON           DEFAULT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_ps_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Portfolio Fit ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_portfolio_fit (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    fit_score       INT            NOT NULL,
    sector_exposure_impact VARCHAR(20) NOT NULL,
    direction_impact VARCHAR(20)   NOT NULL,
    capital_availability VARCHAR(20) NOT NULL,
    correlation_cluster VARCHAR(50) DEFAULT NULL,
    correlation_penalty DECIMAL(5,2) DEFAULT 0,
    portfolio_decision VARCHAR(30)  NOT NULL,
    penalties_json  JSON           DEFAULT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_pf_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Execution Readiness ──────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_execution_readiness (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    status          VARCHAR(40)    NOT NULL,
    action_tag      VARCHAR(30)    NOT NULL,
    priority_rank   INT            DEFAULT NULL,
    approval_decision VARCHAR(20)  NOT NULL,
    reasons_json    JSON           DEFAULT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_er_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Signal Lifecycle ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_lifecycle (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    state           VARCHAR(20)    NOT NULL,
    reason          VARCHAR(255)   NOT NULL,
    changed_at      DATETIME       NOT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_lc_signal (signal_id),
    INDEX idx_lc_state (state)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function migrateSignalEngine(): Promise<void> {
  console.log('[SignalEngine] Running migration...');

  for (const ddl of TABLES) {
    await db.query(ddl);
  }

  // ── Provenance columns (idempotent ALTERs) ──────────────────
  // Added during the Phase 1 cutover so every persisted signal
  // records which engine path produced it. Columns are nullable
  // to stay backward-compatible with historical rows.
  await ensureColumn('q365_signals', 'engine_phase',       "VARCHAR(10) NULL");
  await ensureColumn('q365_signals', 'engine_version',     "VARCHAR(30) NULL");
  await ensureColumn('q365_signals', 'generation_source',  "VARCHAR(40) NULL");
  await ensureColumn('q365_signals', 'code_build',         "VARCHAR(60) NULL");

  // ── Enrichment columns (idempotent ALTERs) ──────────────────
  // Added so the feedback loop and backtest analytics can bucket
  // performance by sector and volatility regime without resorting
  // to 'unknown'/null placeholders. Both columns are nullable for
  // backward-compat with historical rows; new rows are populated
  // by saveSignals.ts from getSector() and features.volatility.atrPct.
  await ensureColumn('q365_signals', 'sector',           "VARCHAR(50) NULL");
  await ensureColumn('q365_signals', 'volatility_state', "VARCHAR(20) NULL");

  // ── Dynamic-ranking columns ─────────────────────────────────
  // Written at INSERT by saveSignals (seeded as "fresh") and
  // continuously updated by rescoreActiveSignals (cron, every
  // 5m intraday). The read path orders by final_score DESC and
  // filters on invalidation_reason/decay_state so stale signals
  // are automatically pushed off the dashboard.
  await ensureColumn('q365_signals', 'final_score',         "DECIMAL(6,2) NOT NULL DEFAULT 0");
  await ensureColumn('q365_signals', 'freshness_score',     "DECIMAL(5,2) NOT NULL DEFAULT 100");
  await ensureColumn('q365_signals', 'decay_state',         "VARCHAR(30)  NOT NULL DEFAULT 'fresh'");
  await ensureColumn('q365_signals', 'age_bars',            "INT          NOT NULL DEFAULT 0");
  await ensureColumn('q365_signals', 'overextension_pct',   "DECIMAL(8,4) NOT NULL DEFAULT 0");
  await ensureColumn('q365_signals', 'invalidation_reason', "VARCHAR(60)  NULL");
  await ensureColumn('q365_signals', 'invalidated_at',      "DATETIME     NULL");
  await ensureColumn('q365_signals', 'last_rescored_at',    "DATETIME     NULL");
  await ensureColumn('q365_signals', 'expires_at',          "DATETIME     NULL");

  await ensureIndex('q365_signals', 'idx_q365sig_final_score',  '(final_score DESC)');
  await ensureIndex('q365_signals', 'idx_q365sig_rescore',      '(last_rescored_at)');
  await ensureIndex('q365_signals', 'idx_q365sig_invalidation', '(invalidation_reason)');

  console.log('[SignalEngine] Migration complete — 8 tables + provenance + enrichment + dynamic ranking');
}

/** Add an index to a table only if it's missing. Safe to call repeatedly. */
async function ensureIndex(table: string, indexName: string, columns: string): Promise<void> {
  const { rows } = await db.query<{ INDEX_NAME: string }>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName],
  );
  if (rows.length === 0) {
    await db.query(`CREATE INDEX ${indexName} ON ${table} ${columns}`);
    console.log(`[SignalEngine] Added index ${table}.${indexName}`);
  }
}

/** Add a column to a table only if it's missing. Safe to call repeatedly. */
async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length === 0) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[SignalEngine] Added column ${table}.${column}`);
  }
}

// Allow direct execution: npx tsx src/lib/db/migrateSignalEngine.ts
//
// When invoked as a script we must load .env.local ourselves —
// Next.js does this automatically in the app runtime, PM2+scheduler
// does it via dotenv in workers/scheduler.ts, but neither path is
// active here. Mirror the scheduler's approach so the migration
// can be run as a standalone one-liner on a fresh clone.
if (require.main === module) {
  const path = require('path');
  require('dotenv').config({
    path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
  });

  migrateSignalEngine()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
