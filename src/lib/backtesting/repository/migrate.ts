// ════════════════════════════════════════════════════════════════
//  Backtesting Engine — Full Database Schema (8 tables)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

let _migrated = false;

/** Ensure tables exist (idempotent, runs once per process) */
export async function ensureBacktestTables(): Promise<void> {
  if (_migrated) return;
  await migrateBacktestTables();
  _migrated = true;
}

export async function migrateBacktestTables(): Promise<void> {
  // 1. Backtest runs
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL UNIQUE,
      name            VARCHAR(255)  NOT NULL,
      description     TEXT,
      config_json     JSON          NOT NULL,
      status          VARCHAR(20)   NOT NULL DEFAULT 'queued',
      started_at      DATETIME      NOT NULL,
      completed_at    DATETIME      NULL,
      duration_ms     INT           NULL,
      error           TEXT          NULL,
      summary_json    JSON          NULL,
      strategy_breakdown_json JSON  NULL,
      regime_breakdown_json   JSON  NULL,
      signal_count    INT           DEFAULT 0,
      trade_count     INT           DEFAULT 0,
      created_by      VARCHAR(100)  NULL,
      tags_json       JSON          NULL,
      INDEX idx_br_status  (status),
      INDEX idx_br_started (started_at DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 2. Backtest signals
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_signals (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      signal_id       VARCHAR(64)   NOT NULL,
      symbol          VARCHAR(50)   NOT NULL,
      date            DATE          NOT NULL,
      bar_index       INT           NOT NULL,
      direction       VARCHAR(10)   NOT NULL,
      strategy        VARCHAR(50)   NOT NULL,
      regime          VARCHAR(30),
      confidence_score SMALLINT,
      confidence_band VARCHAR(30),
      risk_score      SMALLINT,
      sector          VARCHAR(50),
      entry_zone_low  DECIMAL(12,2),
      entry_zone_high DECIMAL(12,2),
      stop_loss       DECIMAL(12,2),
      target1         DECIMAL(12,2),
      target2         DECIMAL(12,2),
      target3         DECIMAL(12,2),
      risk_per_unit   DECIMAL(12,2),
      reward_risk     DECIMAL(6,2),
      status          VARCHAR(20)   DEFAULT 'pending',
      bars_waited     INT           DEFAULT 0,
      reasons_json    JSON,
      features_json   JSON,
      manipulation_score        SMALLINT NULL,
      manipulation_band         VARCHAR(20) NULL,
      excluded_by_manipulation  TINYINT(1) NOT NULL DEFAULT 0,
      manipulation_scenario     VARCHAR(60) NULL,
      INDEX idx_bs_run    (run_id),
      INDEX idx_bs_symbol (symbol),
      INDEX idx_bs_strat  (strategy),
      INDEX idx_bs_date   (date),
      INDEX idx_bs_manip  (manipulation_band)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Phase 3 — idempotent ALTER for existing installs that pre-date the
  // manipulation columns. MySQL has no ADD COLUMN IF NOT EXISTS so we
  // probe information_schema first and skip on duplicate.
  await addBacktestSignalColumnIfMissing('manipulation_score', 'SMALLINT NULL');
  await addBacktestSignalColumnIfMissing('manipulation_band', 'VARCHAR(20) NULL');
  await addBacktestSignalColumnIfMissing('excluded_by_manipulation', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addBacktestSignalColumnIfMissing('manipulation_scenario', 'VARCHAR(60) NULL');

  // Enrichment — keeps backtest_signals aligned with q365_signals so
  // feedback and backtest analytics can bucket by the same volatility
  // regime labels. `sector` was already on the CREATE TABLE above.
  await addBacktestSignalColumnIfMissing('volatility_state', 'VARCHAR(20) NULL');

  // 3. Backtest trades
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_trades (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      trade_id        VARCHAR(64)   NOT NULL,
      signal_id       VARCHAR(64),
      symbol          VARCHAR(50)   NOT NULL,
      sector          VARCHAR(50),
      direction       VARCHAR(10)   NOT NULL,
      strategy        VARCHAR(50)   NOT NULL,
      regime          VARCHAR(30),
      confidence_score SMALLINT,
      confidence_band VARCHAR(30),
      signal_date     DATE,
      entry_date      DATE,
      exit_date       DATE,
      bars_to_entry   INT DEFAULT 0,
      bars_in_trade   INT DEFAULT 0,
      entry_price     DECIMAL(12,2),
      exit_price      DECIMAL(12,2),
      stop_loss       DECIMAL(12,2),
      target1         DECIMAL(12,2),
      target2         DECIMAL(12,2),
      target3         DECIMAL(12,2),
      position_size   INT DEFAULT 0,
      position_value  DECIMAL(14,2) DEFAULT 0,
      risk_amount     DECIMAL(12,2) DEFAULT 0,
      slippage_cost   DECIMAL(10,2) DEFAULT 0,
      commission_cost DECIMAL(10,2) DEFAULT 0,
      gross_pnl       DECIMAL(14,2) DEFAULT 0,
      net_pnl         DECIMAL(14,2) DEFAULT 0,
      return_pct      DECIMAL(8,4)  DEFAULT 0,
      return_r        DECIMAL(8,4)  DEFAULT 0,
      outcome         VARCHAR(20),
      exit_reason     VARCHAR(30),
      mfe_pct         DECIMAL(8,4)  DEFAULT 0,
      mae_pct         DECIMAL(8,4)  DEFAULT 0,
      mfe_r           DECIMAL(8,4)  DEFAULT 0,
      mae_r           DECIMAL(8,4)  DEFAULT 0,
      target1_hit     TINYINT(1) DEFAULT 0,
      target2_hit     TINYINT(1) DEFAULT 0,
      target3_hit     TINYINT(1) DEFAULT 0,
      stop_hit        TINYINT(1) DEFAULT 0,
      target1_hit_bar INT NULL,
      target2_hit_bar INT NULL,
      target3_hit_bar INT NULL,
      stop_hit_bar    INT NULL,
      INDEX idx_bt_run     (run_id),
      INDEX idx_bt_symbol  (symbol),
      INDEX idx_bt_strat   (strategy),
      INDEX idx_bt_outcome (outcome),
      INDEX idx_bt_date    (signal_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 4. Signal outcomes
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_signal_outcomes (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      signal_id       VARCHAR(64)   NOT NULL,
      trade_id        VARCHAR(64)   NULL,
      entry_triggered TINYINT(1)    DEFAULT 0,
      bars_to_entry   INT           NULL,
      target1_hit     TINYINT(1)    DEFAULT 0,
      target2_hit     TINYINT(1)    DEFAULT 0,
      target3_hit     TINYINT(1)    DEFAULT 0,
      stop_hit        TINYINT(1)    DEFAULT 0,
      max_fav_excursion_pct DECIMAL(8,4) DEFAULT 0,
      max_adv_excursion_pct DECIMAL(8,4) DEFAULT 0,
      return_bar5_pct DECIMAL(8,4)  NULL,
      return_bar10_pct DECIMAL(8,4) NULL,
      outcome_label   VARCHAR(30)   NOT NULL,
      evaluated_at    DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bso_run    (run_id),
      INDEX idx_bso_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 5. Metrics key-value store
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_metrics (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      metric_key      VARCHAR(100)  NOT NULL,
      metric_value    DECIMAL(14,4) NOT NULL,
      metric_unit     VARCHAR(20)   DEFAULT '',
      category        VARCHAR(30)   NOT NULL,
      description     VARCHAR(255),
      UNIQUE KEY uq_bm (run_id, metric_key),
      INDEX idx_bm_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 6. Calibration snapshots
  await db.query(`
    CREATE TABLE IF NOT EXISTS calibration_snapshots (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      bucket          VARCHAR(20)   NOT NULL,
      strategy        VARCHAR(50)   DEFAULT 'all',
      regime          VARCHAR(30)   DEFAULT 'all',
      sample_size     INT           DEFAULT 0,
      expected_hit_rate DECIMAL(5,4) DEFAULT 0,
      actual_hit_rate DECIMAL(5,4)  DEFAULT 0,
      avg_mfe_pct     DECIMAL(8,4)  DEFAULT 0,
      avg_mae_pct     DECIMAL(8,4)  DEFAULT 0,
      calibration_state VARCHAR(30),
      modifier_suggestion DECIMAL(5,2) DEFAULT 0,
      computed_at     DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cs_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 7. Equity curve
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_equity_curve (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      date            DATE          NOT NULL,
      equity          DECIMAL(14,2) NOT NULL,
      cash            DECIMAL(14,2) NOT NULL,
      open_position_value DECIMAL(14,2) DEFAULT 0,
      drawdown_pct    DECIMAL(8,4)  DEFAULT 0,
      open_positions  INT           DEFAULT 0,
      day_pnl         DECIMAL(12,2) DEFAULT 0,
      UNIQUE KEY uq_ec (run_id, date),
      INDEX idx_ec_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 8. Audit logs
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_audit_logs (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      timestamp       DATETIME      NOT NULL,
      bar_index       INT           NOT NULL,
      action          VARCHAR(40)   NOT NULL,
      symbol          VARCHAR(50)   NULL,
      message         TEXT,
      payload_json    JSON,
      INDEX idx_bal_run    (run_id),
      INDEX idx_bal_action (action)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 9. Performance metrics (Section 2)
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_performance_metrics (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      run_id              VARCHAR(64)   NOT NULL UNIQUE,
      total_runtime_ms    INT           NOT NULL,
      memory_rss_mb       INT           NULL,
      memory_heap_mb      INT           NULL,
      signals_per_sec     DECIMAL(10,2) DEFAULT 0,
      trades_per_sec      DECIMAL(10,2) DEFAULT 0,
      symbols_processed   INT           DEFAULT 0,
      trading_days        INT           DEFAULT 0,
      ms_per_trading_day  DECIMAL(10,2) DEFAULT 0,
      created_at          DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_perf_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 10. Add user_id to backtest_runs if missing (Section 7) — idempotent
  try {
    await db.query(`ALTER TABLE backtest_runs ADD COLUMN user_id INT NULL`);
    await db.query(`ALTER TABLE backtest_runs ADD INDEX idx_br_user (user_id)`);
  } catch {
    // column / index already exists — fine
  }

  // 11. Production indexes for hot queries (Section 8) — idempotent
  const indexCreations = [
    `ALTER TABLE backtest_signals ADD INDEX idx_bs_run_sigid (run_id, signal_id)`,
    `ALTER TABLE backtest_trades ADD INDEX idx_bt_run_sigid (run_id, signal_id)`,
    `ALTER TABLE backtest_signal_outcomes ADD INDEX idx_bso_run_sigid (run_id, signal_id)`,
  ];
  for (const ddl of indexCreations) {
    try { await db.query(ddl); } catch { /* index already exists */ }
  }

  // 12. Section 1 — extended performance columns (idempotent).
  const perfColumns = [
    `ALTER TABLE backtest_performance_metrics ADD COLUMN preload_ms INT NULL`,
    `ALTER TABLE backtest_performance_metrics ADD COLUMN simulation_ms INT NULL`,
    `ALTER TABLE backtest_performance_metrics ADD COLUMN avg_ms_per_symbol DECIMAL(10,2) NULL`,
    `ALTER TABLE backtest_performance_metrics ADD COLUMN max_ms_per_symbol INT NULL`,
    `ALTER TABLE backtest_performance_metrics ADD COLUMN concurrency INT NULL`,
  ];
  for (const ddl of perfColumns) {
    try { await db.query(ddl); } catch { /* column exists */ }
  }

  // 13. Phase 5 — news analytics per backtest run (one row per impact bucket)
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_news_analytics (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL,
      bucket          VARCHAR(30)   NOT NULL,
      trades          INT           NOT NULL DEFAULT 0,
      win_rate        DECIMAL(5,4)  DEFAULT 0,
      expectancy_r    DECIMAL(8,4)  DEFAULT 0,
      avg_mfe         DECIMAL(8,4)  DEFAULT 0,
      avg_mae         DECIMAL(8,4)  DEFAULT 0,
      profit_factor   DECIMAL(8,4)  DEFAULT 0,
      avg_conf_mod    DECIMAL(5,2)  DEFAULT 0,
      insight         TEXT,
      created_at      DATETIME      DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_bna (run_id, bucket),
      INDEX idx_bna_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 14. Phase 5 — news effectiveness comparison (with-news vs without-news)
  await db.query(`
    CREATE TABLE IF NOT EXISTS backtest_news_effectiveness (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NOT NULL UNIQUE,
      baseline_win_rate      DECIMAL(5,4) DEFAULT 0,
      news_aware_win_rate    DECIMAL(5,4) DEFAULT 0,
      win_rate_delta         DECIMAL(5,4) DEFAULT 0,
      baseline_expectancy_r  DECIMAL(8,4) DEFAULT 0,
      news_aware_expectancy_r DECIMAL(8,4) DEFAULT 0,
      expectancy_delta       DECIMAL(8,4) DEFAULT 0,
      news_effectiveness_score DECIMAL(5,2) DEFAULT 0,
      news_adds_value        TINYINT(1)   DEFAULT 0,
      summary                TEXT,
      created_at             DATETIME     DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bne_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Phase 5 — add news columns to backtest_signals if missing
  const newsSignalCols = [
    { name: 'news_impact_score',       def: 'SMALLINT NULL' },
    { name: 'news_confidence_modifier', def: 'SMALLINT NULL' },
    { name: 'news_risk_penalty',       def: 'SMALLINT NULL' },
    { name: 'news_event_risk_score',   def: 'SMALLINT NULL' },
    { name: 'news_sentiment',          def: "VARCHAR(20) NULL" },
    { name: 'excluded_by_news_filter', def: 'TINYINT(1) DEFAULT 0' },
  ];
  for (const col of newsSignalCols) {
    await addBacktestSignalColumnIfMissing(col.name, col.def);
  }

  // Phase 5 — add pnl_r to backtest_signal_outcomes if missing
  await addBacktestSignalColumnIfMissing('pnl_r', 'DECIMAL(8,4) DEFAULT 0');

  // Queue-mode columns (idempotent) — needed by src/lib/backtesting/runner/backtestQueue.ts.
  // The queue worker uses these to surface progress to the UI while the
  // run is RUNNING. Old completed rows simply have NULL/0 — the UI
  // shows safe defaults for them.
  const runColumns = [
    `ALTER TABLE backtest_runs ADD COLUMN progress_percent INT NOT NULL DEFAULT 0`,
    `ALTER TABLE backtest_runs ADD COLUMN current_step VARCHAR(100) NULL`,
    `ALTER TABLE backtest_runs ADD COLUMN updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP`,
  ];
  for (const ddl of runColumns) {
    try { await db.query(ddl); } catch { /* column exists */ }
  }
}

/** Idempotent helper to add columns to backtest tables. */
async function addBacktestSignalColumnIfMissing(name: string, def: string): Promise<void> {
  // Try backtest_signals first, then backtest_signal_outcomes
  for (const table of ['backtest_signals', 'backtest_signal_outcomes']) {
    try {
      await db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    } catch {
      // Column already exists or table doesn't have it — fine.
    }
  }
}
