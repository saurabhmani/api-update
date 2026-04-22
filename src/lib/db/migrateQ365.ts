/**
 * Quantorus365 — Intelligence Layer Migration
 *
 * Creates all new tables required for:
 *   Fix 1: Hard Rejection Engine
 *   Fix 2: Portfolio Fit Service
 *   Fix 3: Scenario Engine
 *   Fix 4: Confidence Engine
 *   Fix 5: Market Stance Engine
 *
 * MySQL-native syntax. No PostgreSQL features.
 * Safe to re-run (IF NOT EXISTS on all tables).
 *
 * Run: npx ts-node -r tsconfig-paths/register src/lib/db/migrateQ365.ts
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

// Load .env.local without dotenv dependency
try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

async function migrateQ365() {
  const { getMysqlConnectionConfig } = await import('../db');
  const cfg = getMysqlConnectionConfig();
  const conn = await mysql.createConnection({
    ...cfg,
    multipleStatements: true,
  });

  console.log('Running Quantorus365 migrations...\n');

  try {
    // ── 1. system_thresholds ────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS system_thresholds (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        key_name    VARCHAR(100) UNIQUE NOT NULL,
        key_value   VARCHAR(100)        NOT NULL,
        description TEXT,
        updated_at  DATETIME            DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_key_name (key_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Drift repair: some DBs were created by an earlier version
    //    of ensureAllSchemas that used config_key / config_value
    //    column names. Rename them back to the canonical form so the
    //    INSERT below (and systemConfigService at runtime) work. Idempotent —
    //    skips the rename if the columns already have the right names.
    const [driftRows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME   = 'system_thresholds'
         AND COLUMN_NAME IN ('config_key', 'config_value')`,
    );
    if (Array.isArray(driftRows) && driftRows.length > 0) {
      console.log(
        `  ↺ system_thresholds drift detected — renaming ` +
        `config_key→key_name, config_value→key_value`,
      );
      const driftCols = new Set(
        (driftRows as Array<{ COLUMN_NAME: string }>).map((r) => r.COLUMN_NAME),
      );
      if (driftCols.has('config_key')) {
        await conn.query(
          `ALTER TABLE system_thresholds
             CHANGE COLUMN config_key key_name VARCHAR(100) NOT NULL`,
        );
      }
      if (driftCols.has('config_value')) {
        await conn.query(
          `ALTER TABLE system_thresholds
             CHANGE COLUMN config_value key_value VARCHAR(100) NOT NULL`,
        );
      }
    }
    // Seed all 25 default thresholds matching systemConfigService.DEFAULTS
    const thresholdSeeds = [
      ['MIN_RR_SWING',              '2.0',   'Min risk-reward for swing trades'],
      ['MIN_RR_POSITIONAL',         '2.5',   'Min risk-reward for positional trades'],
      ['MIN_CONFIDENCE',            '65',    'Min confidence score to emit a signal'],
      ['MIN_COMPOSITE_SCORE',       '45',    'Min composite score (absolute floor)'],
      ['MAX_RISK_SCORE',            '75',    'Max acceptable risk score'],
      ['MIN_DATA_QUALITY',          '0.40',  'Min data quality score (0–1)'],
      ['MIN_LIQUIDITY_VOLUME',      '100000','Min daily volume for liquidity gate'],
      ['MIN_VOLUME_INTRADAY',       '10000', 'Min intraday volume for liquidity gate'],
      ['MAX_SECTOR_EXPOSURE',       '30',    'Max portfolio % in any single sector'],
      ['MAX_POSITIONS',             '12',    'Max concurrent open positions'],
      ['MAX_STRATEGY_CONCENTRATION','0.50',  'Max fraction of positions in one strategy'],
      ['MAX_CORRELATION',           '0.75',  'Max avg pairwise correlation'],
      ['MIN_PORTFOLIO_FIT',         '40',    'Min portfolio fit score to approve signal'],
      ['MAX_DRAWDOWN_BLOCK',        '15',    'Block new entries if drawdown exceeds this %'],
      ['CAPITAL_AT_RISK_CAP',       '20',    'Max % of portfolio in active risk at once'],
      ['MAX_STOP_ATR_MULTIPLE',     '3.5',   'Stop distance max (× ATR14)'],
      ['MIN_STOP_ATR_MULTIPLE',     '0.5',   'Stop distance min (× ATR14)'],
      ['WEIGHT_FACTOR_ALIGNMENT',   '0.22',  'Confidence weight: factor alignment'],
      ['WEIGHT_STRATEGY_CLARITY',   '0.14',  'Confidence weight: strategy clarity'],
      ['WEIGHT_REGIME_ALIGNMENT',   '0.14',  'Confidence weight: regime alignment'],
      ['WEIGHT_LIQUIDITY',          '0.10',  'Confidence weight: liquidity quality'],
      ['WEIGHT_DATA_QUALITY',       '0.08',  'Confidence weight: data quality'],
      ['WEIGHT_PORTFOLIO_FIT',      '0.12',  'Confidence weight: portfolio fit'],
      ['WEIGHT_PARTICIPATION',      '0.06',  'Confidence weight: participation'],
      ['WEIGHT_RR_QUALITY',         '0.08',  'Confidence weight: R:R quality'],
      ['WEIGHT_VOLATILITY_FIT',     '0.06',  'Confidence weight: volatility fit'],
      ['CORRELATION_LOOKBACK_DAYS', '60',    'Days of candle history for correlation'],
    ] as const;

    for (const [k, v, d] of thresholdSeeds) {
      await conn.execute(
        'INSERT IGNORE INTO system_thresholds (key_name, key_value, description) VALUES (?, ?, ?)',
        [k, v, d]
      );
    }
    console.log('✓ system_thresholds');

    // ── 2. signal_rejections ────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signal_rejections (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        signal_id             INT           NULL,
        symbol                VARCHAR(50)   NOT NULL,
        strategy_code         VARCHAR(100),
        regime_code           VARCHAR(30),
        confidence_score      SMALLINT,
        risk_score            SMALLINT,
        rr_ratio              DECIMAL(6,2),
        liquidity_score       SMALLINT,
        portfolio_fit_score   SMALLINT,
        approved              TINYINT(1)    DEFAULT 0,
        rejection_reason_json JSON,
        created_at            DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sr_symbol      (symbol),
        INDEX idx_sr_approved    (approved),
        INDEX idx_sr_created     (created_at),
        INDEX idx_sr_strategy    (strategy_code),
        INDEX idx_sr_regime      (regime_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ signal_rejections');

    // ── 3. market_scenarios ─────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS market_scenarios (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        scenario_date        DATE          DEFAULT (CURDATE()),
        scenario_tag         VARCHAR(50)   NOT NULL,
        scenario_confidence  SMALLINT,
        breadth_state        VARCHAR(30),
        volatility_state     VARCHAR(20),
        sector_rotation_json JSON,
        index_state_json     JSON,
        notes_json           JSON,
        created_at           DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ms_date     (scenario_date),
        INDEX idx_ms_tag      (scenario_tag),
        INDEX idx_ms_created  (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ market_scenarios');

    // ── 4. market_stance_logs ───────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS market_stance_logs (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        stance_date          DATE          DEFAULT (CURDATE()),
        market_stance        VARCHAR(30)   NOT NULL,
        stance_confidence    SMALLINT,
        scenario_tag         VARCHAR(50),
        breadth_score        SMALLINT,
        volatility_score     SMALLINT,
        rejection_rate       DECIMAL(5,2),
        avg_top_confidence   SMALLINT,
        notes_json           JSON,
        created_at           DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_msl_date    (stance_date),
        INDEX idx_msl_stance  (market_stance),
        INDEX idx_msl_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ market_stance_logs');

    // ── 5. confidence_logs ──────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS confidence_logs (
        id                       INT AUTO_INCREMENT PRIMARY KEY,
        signal_id                INT           NULL,
        symbol                   VARCHAR(50)   NOT NULL,
        confidence_score         SMALLINT      NOT NULL,
        factor_alignment_score   SMALLINT,
        strategy_clarity_score   SMALLINT,
        regime_alignment_score   SMALLINT,
        liquidity_score          SMALLINT,
        data_quality_score       SMALLINT,
        portfolio_fit_score      SMALLINT,
        participation_score      SMALLINT,
        rr_quality_score         SMALLINT,
        volatility_fit_score     SMALLINT,
        created_at               DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cl_symbol      (symbol),
        INDEX idx_cl_conf        (confidence_score),
        INDEX idx_cl_signal      (signal_id),
        INDEX idx_cl_created     (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ confidence_logs');

    // ── 6. portfolio_exposure_snapshots ─────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_exposure_snapshots (
        id                       INT AUTO_INCREMENT PRIMARY KEY,
        snapshot_date            DATE          DEFAULT (CURDATE()),
        total_exposure_pct       DECIMAL(6,2),
        cash_pct                 DECIMAL(6,2),
        sector_exposure_json     JSON,
        strategy_exposure_json   JSON,
        directional_exposure_json JSON,
        risk_budget_used_pct     DECIMAL(6,2),
        created_at               DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pes_date       (snapshot_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ portfolio_exposure_snapshots');

    // ── 7. portfolio_position_correlations ──────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_position_correlations (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        symbol_a          VARCHAR(50)   NOT NULL,
        symbol_b          VARCHAR(50)   NOT NULL,
        correlation_value DECIMAL(6,4)  NOT NULL,
        lookback_days     SMALLINT      DEFAULT 60,
        updated_at        DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ppc_pair (symbol_a, symbol_b),
        INDEX idx_ppc_a   (symbol_a),
        INDEX idx_ppc_b   (symbol_b),
        INDEX idx_ppc_val (correlation_value)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ portfolio_position_correlations');

    // ── 8. portfolio_fit_logs ───────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_fit_logs (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        symbol               VARCHAR(50)   NOT NULL,
        signal_id            INT           NULL,
        portfolio_fit_score  SMALLINT      NOT NULL,
        sector_penalty       SMALLINT,
        correlation_penalty  SMALLINT,
        strategy_penalty     SMALLINT,
        drawdown_penalty     SMALLINT,
        notes_json           JSON,
        created_at           DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pfl_symbol   (symbol),
        INDEX idx_pfl_score    (portfolio_fit_score),
        INDEX idx_pfl_created  (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ portfolio_fit_logs');

    // ── 9. Extend signals table ─────────────────────────────────
    // Add new columns if not already present
    const signalCols = [
      ["scenario_tag",        "VARCHAR(100) NULL"],
      ["market_stance",       "VARCHAR(30)  NULL"],
      ["confidence_score",    "SMALLINT     NULL"],
      ["portfolio_fit_score", "SMALLINT     NULL"],
      ["conviction_band",     "VARCHAR(30)  NULL"],
      ["regime_alignment",    "SMALLINT     NULL"],
      ["rejection_json",      "JSON         NULL"],
    ];

    for (const [col, def] of signalCols) {
      try {
        await conn.execute(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${def}`);
      } catch {}
    }
    console.log('✓ signals (extended)');

    // ── 10. Extend rankings table ───────────────────────────────
    const rankingCols = [
      ["portfolio_fit_score", "SMALLINT NULL"],
      ["confidence_score",    "SMALLINT NULL"],
      ["conviction_band",     "VARCHAR(30) NULL"],
      ["market_stance",       "VARCHAR(30) NULL"],
      ["scenario_tag",        "VARCHAR(100) NULL"],
    ];
    for (const [col, def] of rankingCols) {
      try {
        await conn.execute(`ALTER TABLE rankings ADD COLUMN IF NOT EXISTS ${col} ${def}`);
      } catch {}
    }
    console.log('✓ rankings (extended)');

    // ── 11. strategy_performance (if not from prior migration) ──
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS strategy_performance (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        strategy_key     VARCHAR(100) NOT NULL,
        regime           VARCHAR(30),
        confidence_band  VARCHAR(20),
        period_start     DATE,
        period_end       DATE,
        signals_total    INT         DEFAULT 0,
        signals_win      INT         DEFAULT 0,
        signals_loss     INT         DEFAULT 0,
        hit_rate         DECIMAL(5,1),
        updated_at       DATETIME    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sp (strategy_key, regime, confidence_band, period_start),
        INDEX idx_sp_strategy (strategy_key),
        INDEX idx_sp_regime   (regime)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ strategy_performance');

    // ── 12. signal_quality_events (if not from prior migration) ──
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signal_quality_events (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50),
        event_type     VARCHAR(50)  NOT NULL,
        details        TEXT,
        created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sqe_symbol  (tradingsymbol),
        INDEX idx_sqe_type    (event_type),
        INDEX idx_sqe_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✓ signal_quality_events');

    console.log('\n✅ All Quantorus365 migrations complete.');
  } finally {
    await conn.end();
  }
}

migrateQ365().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
