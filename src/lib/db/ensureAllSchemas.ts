// ════════════════════════════════════════════════════════════════
//  Master Auto-Migration — Creates all tables on first call
//
//  This is the single source of truth for auto-creating every
//  table the app needs. Called automatically by API routes via
//  the `ensureAllSchemas()` export.
//
//  SAFE: Every DDL uses `CREATE TABLE IF NOT EXISTS` — running
//  this multiple times does nothing on existing tables.
//
//  IDEMPOTENT: Runs only once per process (cached in-memory).
//  Set `force: true` to re-run.
// ════════════════════════════════════════════════════════════════

import { db } from '../db';
import { migrateMarketData } from './migrateMarketData';
import { migrateSignalEngine } from './migrateSignalEngine';

let _ensured = false;

const ALL_TABLES: string[] = [
  // ── CORE ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) DEFAULT NULL,
    role ENUM('user','admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    totp_secret VARCHAR(255) DEFAULT NULL,
    totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
    failed_login_attempts INT NOT NULL DEFAULT 0,
    locked_until DATETIME DEFAULT NULL,
    last_login_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS user_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(128) NOT NULL UNIQUE,
    device VARCHAR(255) DEFAULT NULL,
    ip_address VARCHAR(45) DEFAULT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_token (token),
    INDEX idx_expires (expires_at)
  ) ENGINE=InnoDB`,

  // Forgot-password flow. The auth service inserts/updates rows here
  // when a reset is requested or consumed (services/auth.ts:153,168).
  `CREATE TABLE IF NOT EXISTS password_resets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    used TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_pwreset_user (user_id),
    INDEX idx_pwreset_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS instruments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tradingsymbol VARCHAR(50) NOT NULL,
    instrument_key VARCHAR(60) DEFAULT NULL,
    exchange VARCHAR(20) NOT NULL DEFAULT 'NSE',
    name VARCHAR(200) DEFAULT NULL,
    sector VARCHAR(80) DEFAULT 'Other',
    industry VARCHAR(120) DEFAULT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_symbol (tradingsymbol, exchange),
    INDEX idx_sector (sector)
  ) ENGINE=InnoDB`,

  // Note: `market_data_daily` is intentionally NOT created here.
  // `ensureSignalEngineSchemas` (src/lib/signal-engine/repository/ensureSchemas.ts)
  // defines it as a VIEW projecting the legacy shape over `candles`.
  // Creating it as a BASE TABLE here caused a rename/DDL race: one
  // schema-ensure path created the table, the other renamed it to
  // `_legacy` and created a VIEW, and a long-running SELECT on the
  // name would queue every subsequent CREATE/RENAME/read behind a
  // metadata lock — exhausting the 10-connection pool and hanging
  // every API route indefinitely.
  //
  // Note: `candles` and `market_data_snapshots` are created by
  // migrateMarketData() which is called below in ensureAllSchemas().
  // Keeping the market data DDL in its dedicated migration file
  // avoids drift between CLI migration and auto-migration paths.

  // ── PORTFOLIO ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS portfolios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'Default',
    capital DECIMAL(14,2) NOT NULL DEFAULT 1000000,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS portfolio_positions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    portfolio_id INT NOT NULL,
    instrument_id INT,
    instrument_key VARCHAR(150),
    tradingsymbol VARCHAR(50) NOT NULL,
    exchange VARCHAR(20),
    quantity INT NOT NULL,
    buy_price DECIMAL(14,4) NOT NULL,
    avg_cost DECIMAL(12,2),
    current_price DECIMAL(14,4) DEFAULT NULL,
    market_value DECIMAL(14,2),
    unrealized_pnl DECIMAL(14,2),
    realized_pnl DECIMAL(14,2) DEFAULT 0,
    as_of DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_portfolio (portfolio_id),
    INDEX idx_pp_instrument_id (instrument_id)
  ) ENGINE=InnoDB`,

  // ── SIGNAL ENGINE CORE ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signals (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    instrument_key VARCHAR(60) DEFAULT NULL,
    exchange VARCHAR(20) NOT NULL DEFAULT 'NSE',
    direction VARCHAR(10) NOT NULL,
    timeframe VARCHAR(20) NOT NULL DEFAULT 'daily',
    signal_type VARCHAR(60) NOT NULL,
    confidence_score INT NOT NULL DEFAULT 0,
    confidence_band VARCHAR(30) DEFAULT NULL,
    risk_score INT NOT NULL DEFAULT 0,
    risk_band VARCHAR(30) DEFAULT NULL,
    entry_price DECIMAL(14,4) NOT NULL DEFAULT 0,
    stop_loss DECIMAL(14,4) NOT NULL DEFAULT 0,
    target1 DECIMAL(14,4) NOT NULL DEFAULT 0,
    target2 DECIMAL(14,4) NOT NULL DEFAULT 0,
    risk_reward DECIMAL(6,2) NOT NULL DEFAULT 0,
    market_regime VARCHAR(40) DEFAULT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    opportunity_score INT DEFAULT NULL,
    scenario_tag VARCHAR(60) DEFAULT NULL,
    market_stance VARCHAR(40) DEFAULT NULL,
    factor_scores_json JSON DEFAULT NULL,
    sector VARCHAR(80) DEFAULT NULL,
    volatility_state VARCHAR(30) DEFAULT NULL,
    engine_phase INT DEFAULT NULL,
    engine_version VARCHAR(20) DEFAULT NULL,
    generation_source VARCHAR(100) DEFAULT NULL,
    code_build VARCHAR(40) DEFAULT NULL,
    batch_id VARCHAR(60) DEFAULT NULL,
    INDEX idx_symbol_status (symbol, status),
    INDEX idx_status_gen (status, generated_at),
    INDEX idx_batch (batch_id),
    INDEX idx_generation_source (generation_source)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_signal_reasons (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id BIGINT NOT NULL,
    reason_type ENUM('reason','warning') NOT NULL,
    message VARCHAR(500) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_signal (signal_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_signal_feature_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id BIGINT NOT NULL,
    features_json JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_signal (signal_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_signal_lifecycle (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id BIGINT NOT NULL,
    state VARCHAR(30) NOT NULL,
    reason VARCHAR(200) DEFAULT NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_signal (signal_id),
    INDEX idx_state (state)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_strategy_breakdowns (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id BIGINT NOT NULL,
    strategy_name VARCHAR(60) NOT NULL,
    matched BOOLEAN NOT NULL DEFAULT FALSE,
    confidence_score INT NOT NULL DEFAULT 0,
    risk_score INT NOT NULL DEFAULT 0,
    regime_fit DECIMAL(5,2) DEFAULT NULL,
    rs_alignment DECIMAL(5,2) DEFAULT NULL,
    sector_fit DECIMAL(5,2) DEFAULT NULL,
    structural_quality DECIMAL(5,2) DEFAULT NULL,
    rejection_reason VARCHAR(300) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_signal_strategy (signal_id, strategy_name),
    INDEX idx_signal (signal_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_signal_outcomes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id BIGINT NOT NULL,
    entry_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    bars_to_entry INT DEFAULT NULL,
    target1_hit BOOLEAN NOT NULL DEFAULT FALSE,
    target2_hit BOOLEAN NOT NULL DEFAULT FALSE,
    target3_hit BOOLEAN NOT NULL DEFAULT FALSE,
    stop_hit BOOLEAN NOT NULL DEFAULT FALSE,
    max_fav_excursion_pct DECIMAL(8,4) DEFAULT NULL,
    max_adv_excursion_pct DECIMAL(8,4) DEFAULT NULL,
    pnl_r DECIMAL(8,4) DEFAULT NULL,
    return_bar5_pct DECIMAL(8,4) DEFAULT NULL,
    return_bar10_pct DECIMAL(8,4) DEFAULT NULL,
    outcome_label VARCHAR(40) DEFAULT NULL,
    evaluated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_signal (signal_id),
    INDEX idx_evaluated (evaluated_at),
    INDEX idx_outcome (outcome_label)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_signal_explanations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id BIGINT NOT NULL,
    explanation_json JSON NOT NULL,
    context_json JSON DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_signal (signal_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_strategy_performance_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    strategy_name VARCHAR(60) NOT NULL,
    regime VARCHAR(40) NOT NULL,
    volatility_state VARCHAR(30) DEFAULT 'Normal',
    sector VARCHAR(80) DEFAULT NULL,
    sample_size INT NOT NULL DEFAULT 0,
    win_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    target1_hit_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    avg_pnl_r DECIMAL(8,4) NOT NULL DEFAULT 0,
    avg_mfe DECIMAL(8,4) NOT NULL DEFAULT 0,
    avg_mae DECIMAL(8,4) NOT NULL DEFAULT 0,
    environment_fit VARCHAR(30) NOT NULL DEFAULT 'insufficient_data',
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_strategy_regime (strategy_name, regime),
    INDEX idx_computed (computed_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_confidence_calibration (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    bucket VARCHAR(20) NOT NULL,
    strategy_name VARCHAR(60) DEFAULT 'all',
    regime VARCHAR(40) DEFAULT 'all',
    sample_size INT NOT NULL DEFAULT 0,
    target1_hit_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    avg_mfe DECIMAL(8,4) NOT NULL DEFAULT 0,
    calibration_state VARCHAR(40) NOT NULL DEFAULT 'insufficient_data',
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bucket (bucket),
    INDEX idx_computed (computed_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_adaptive_recommendations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    strategy_name VARCHAR(60) NOT NULL,
    regime VARCHAR(40) NOT NULL,
    volatility_state VARCHAR(30) DEFAULT 'Normal',
    sector VARCHAR(80) DEFAULT NULL,
    environment_fit VARCHAR(30) NOT NULL DEFAULT 'insufficient_data',
    recommended_modifier INT NOT NULL DEFAULT 0,
    reason VARCHAR(500) DEFAULT NULL,
    sample_size INT NOT NULL DEFAULT 0,
    evidence_strength VARCHAR(20) NOT NULL DEFAULT 'weak',
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_strategy_regime (strategy_name, regime),
    INDEX idx_computed (computed_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_learning_job_runs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_name VARCHAR(80) NOT NULL,
    status ENUM('success','failed','running') NOT NULL DEFAULT 'success',
    duration_ms INT NOT NULL DEFAULT 0,
    counts_json JSON DEFAULT NULL,
    error_msg TEXT DEFAULT NULL,
    run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_run_at (run_at),
    INDEX idx_job_name (job_name, run_at)
  ) ENGINE=InnoDB`,

  // ── NEWS INTELLIGENCE ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_news_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_id VARCHAR(20) NOT NULL,
    external_id VARCHAR(200) NOT NULL,
    dedup_hash VARCHAR(64) NOT NULL,
    title VARCHAR(500) NOT NULL,
    body TEXT,
    url VARCHAR(1000) NOT NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'general',
    sentiment VARCHAR(30) NOT NULL DEFAULT 'neutral',
    sentiment_score DECIMAL(6,3) NOT NULL DEFAULT 0,
    published_at DATETIME NOT NULL,
    fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    symbols_json JSON DEFAULT NULL,
    sectors_json JSON DEFAULT NULL,
    macro_factors_json JSON DEFAULT NULL,
    commodities_json JSON DEFAULT NULL,
    is_processed BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at DATETIME DEFAULT NULL,
    UNIQUE KEY uq_dedup (dedup_hash),
    INDEX idx_source (source_id),
    INDEX idx_category (category),
    INDEX idx_published (published_at),
    INDEX idx_sentiment (sentiment)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_news_scores (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    news_event_id BIGINT NOT NULL,
    symbol VARCHAR(50) NOT NULL,
    trust_score INT NOT NULL DEFAULT 0,
    trust_tier VARCHAR(30) DEFAULT 'unknown',
    sentiment_score DECIMAL(6,3) NOT NULL DEFAULT 0,
    sentiment_magnitude DECIMAL(6,3) NOT NULL DEFAULT 0,
    sentiment_direction VARCHAR(20) DEFAULT 'neutral',
    importance_score INT NOT NULL DEFAULT 0,
    novelty_score INT NOT NULL DEFAULT 0,
    novelty_is_breaking BOOLEAN NOT NULL DEFAULT FALSE,
    freshness_score INT NOT NULL DEFAULT 0,
    freshness_band VARCHAR(20) DEFAULT NULL,
    directness_score INT NOT NULL DEFAULT 0,
    directness_match VARCHAR(30) DEFAULT NULL,
    manipulation_score INT NOT NULL DEFAULT 0,
    manipulation_flags_json JSON DEFAULT NULL,
    symbol_impact_score INT NOT NULL DEFAULT 0,
    event_risk_score INT NOT NULL DEFAULT 0,
    manipulation_risk_boost INT NOT NULL DEFAULT 0,
    dimensions_json JSON DEFAULT NULL,
    scored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_event_symbol (news_event_id, symbol),
    INDEX idx_symbol (symbol),
    INDEX idx_scored (scored_at),
    INDEX idx_impact (symbol_impact_score),
    INDEX idx_manip_boost (manipulation_risk_boost)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_news_ingestion_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    total_fetched INT NOT NULL DEFAULT 0,
    duplicates_skipped INT NOT NULL DEFAULT 0,
    new_events INT NOT NULL DEFAULT 0,
    errors_json JSON DEFAULT NULL,
    source_breakdown_json JSON DEFAULT NULL,
    duration_ms INT NOT NULL DEFAULT 0,
    ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ran (ran_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_news_calibration (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    dimension VARCHAR(40) NOT NULL,
    dimension_value VARCHAR(100) NOT NULL,
    sample_size INT NOT NULL DEFAULT 0,
    win_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    avg_pnl_r DECIMAL(8,4) NOT NULL DEFAULT 0,
    avg_mfe DECIMAL(8,4) NOT NULL DEFAULT 0,
    avg_mae DECIMAL(8,4) NOT NULL DEFAULT 0,
    target1_hit_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    target2_hit_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    stop_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
    sentiment_accuracy DECIMAL(6,4) NOT NULL DEFAULT 0,
    calibrated_trust DECIMAL(6,4) NOT NULL DEFAULT 0,
    calibration_state VARCHAR(40) NOT NULL DEFAULT 'insufficient_data',
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_dim (dimension, dimension_value),
    INDEX idx_computed (computed_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_news_adaptive_recommendations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    dimension VARCHAR(40) NOT NULL,
    dimension_value VARCHAR(100) NOT NULL,
    current_modifier INT NOT NULL DEFAULT 0,
    recommended_modifier INT NOT NULL DEFAULT 0,
    trust_adjustment INT NOT NULL DEFAULT 0,
    reason VARCHAR(500) DEFAULT NULL,
    sample_size INT NOT NULL DEFAULT 0,
    evidence_strength VARCHAR(20) NOT NULL DEFAULT 'weak',
    computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_dim (dimension, dimension_value),
    INDEX idx_computed (computed_at)
  ) ENGINE=InnoDB`,

  // ── MANIPULATION ENGINE ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_manipulation_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    snapshot_date DATE NOT NULL,
    manipulation_score INT NOT NULL DEFAULT 0,
    suspicion_band VARCHAR(20) NOT NULL DEFAULT 'low',
    explanation VARCHAR(500) DEFAULT NULL,
    features_json JSON DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_symbol_date (symbol, snapshot_date),
    INDEX idx_band (suspicion_band),
    INDEX idx_created (created_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_manipulation_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    snapshot_id BIGINT NOT NULL,
    event_type VARCHAR(60) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'low',
    detector_label VARCHAR(120) DEFAULT NULL,
    detector_score INT NOT NULL DEFAULT 0,
    triggered BOOLEAN NOT NULL DEFAULT FALSE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_snapshot (snapshot_id),
    INDEX idx_event_type (event_type)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_manipulation_detector_results (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    snapshot_id BIGINT NOT NULL,
    detector_name VARCHAR(60) NOT NULL,
    score INT NOT NULL DEFAULT 0,
    triggered BOOLEAN NOT NULL DEFAULT FALSE,
    details_json JSON DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_snapshot (snapshot_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS q365_manipulation_penalties (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id VARCHAR(60) NOT NULL,
    snapshot_id BIGINT NOT NULL,
    confidence_penalty INT NOT NULL DEFAULT 0,
    risk_penalty INT NOT NULL DEFAULT 0,
    rejection_flag BOOLEAN NOT NULL DEFAULT FALSE,
    reason VARCHAR(500) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_signal (signal_id),
    INDEX idx_snapshot (snapshot_id)
  ) ENGINE=InnoDB`,

  // ── BACKTESTING ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_backtest_runs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    config_json JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued',
    started_at DATETIME DEFAULT NULL,
    completed_at DATETIME DEFAULT NULL,
    duration_ms INT DEFAULT NULL,
    error TEXT DEFAULT NULL,
    summary_json JSON DEFAULT NULL,
    signal_count INT NOT NULL DEFAULT 0,
    trade_count INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_created (created_at)
  ) ENGINE=InnoDB`,

  // ── INSTITUTIONAL ALERTS ──────────────────────────────────────
  // Structured alert store with dedup + suppression built in.
  // alert_key is a deterministic SHA-256 over the identifying tuple
  // (category, severity, source, dedup_key) so duplicate inserts
  // short-circuit via ON DUPLICATE KEY UPDATE (suppression counter).
  `CREATE TABLE IF NOT EXISTS q365_alerts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    alert_id VARCHAR(40) NOT NULL UNIQUE,
    category VARCHAR(60) NOT NULL,
    severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    source VARCHAR(80) NOT NULL,
    dedup_key VARCHAR(200) NOT NULL,
    dedup_hash CHAR(64) NOT NULL,
    suppression_state ENUM('active','suppressed','muted') NOT NULL DEFAULT 'active',
    occurrence_count INT NOT NULL DEFAULT 1,
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    resolved_at DATETIME DEFAULT NULL,
    payload JSON DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_alerts_dedup (dedup_hash),
    INDEX idx_alerts_severity (severity, created_at),
    INDEX idx_alerts_category (category, last_seen_at),
    INDEX idx_alerts_state (suppression_state)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── TRADEABLE UNIVERSE (NIFTY 500 by default) ─────────────────
  // Replaces the static nseUniverse.json. Loader: scripts/loadNifty500.ts
  // upserts on each NIFTY 500 review and flips removed symbols to
  // is_active=FALSE (preserves audit history).
  `CREATE TABLE IF NOT EXISTS q365_universe (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    symbol        VARCHAR(32) NOT NULL,
    company_name  VARCHAR(255) NOT NULL,
    isin          VARCHAR(16) DEFAULT NULL,
    sector        VARCHAR(64) DEFAULT NULL,
    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_universe_symbol (symbol),
    INDEX idx_universe_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Override table for IndianAPI symbol mapping. Populate ONLY when
  // the upstream rejects a default-mapped symbol; see symbolMapper.ts.
  `CREATE TABLE IF NOT EXISTS q365_symbol_mapping_override (
    nse_symbol  VARCHAR(32) NOT NULL,
    api_symbol  VARCHAR(32) NOT NULL,
    notes       TEXT DEFAULT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (nse_symbol)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── MARKET-DATA PIPELINE (Step 6 of the IndianAPI cutover) ────
  // Manual pipeline-run lock. One row per (run_type, run_date) — the
  // unique key enforces "manual frontend run allowed once per IST day".
  // Scheduled / system runs use distinct run_type values so the cron
  // path is unaffected.
  `CREATE TABLE IF NOT EXISTS q365_pipeline_run_locks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_type ENUM('manual','scheduled','system') NOT NULL,
    run_date DATE NOT NULL,
    timezone VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata',
    requested_by VARCHAR(255) DEFAULT NULL,
    request_source VARCHAR(64) DEFAULT NULL,
    status ENUM('started','completed','failed','blocked') NOT NULL DEFAULT 'started',
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    force_override TINYINT(1) NOT NULL DEFAULT 0,
    override_reason TEXT DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_runtype_date (run_type, run_date),
    INDEX idx_run_date_status (run_date, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── DATA FEED HEALTH (Step 7) ─────────────────────────────────
  // Per-request observability. Every IndianAPI / cache / NSE-direct /
  // emergency-Yahoo invocation writes one row here. Powers the
  // /api/data-feed/health endpoint and the dashboard freshness panel.
  `CREATE TABLE IF NOT EXISTS q365_data_feed_health (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(40) NOT NULL,
    endpoint VARCHAR(120) NOT NULL,
    request_started_at DATETIME(3) NOT NULL,
    response_received_at DATETIME(3) NOT NULL,
    status VARCHAR(40) NOT NULL,
    latency_ms INT NOT NULL,
    symbols_requested INT NOT NULL DEFAULT 0,
    symbols_returned INT NOT NULL DEFAULT 0,
    coverage_percent INT NOT NULL DEFAULT 0,
    data_quality VARCHAR(20) NOT NULL,
    error_code VARCHAR(80) DEFAULT NULL,
    error_message TEXT DEFAULT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_feed_provider_time (provider, request_started_at),
    INDEX idx_feed_status_time (status, request_started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── SYSTEM CONFIG ─────────────────────────────────────────────
  // Column names MUST be key_name / key_value — systemConfigService.ts,
  // /api/admin/route.ts, setup.ts and migrateQ365.ts all read/write
  // those exact names. An earlier revision of this file used
  // config_key / config_value which caused schema drift on any
  // database where ensureAllSchemas ran before migrateQ365; the
  // drift repair in migrateQ365.ts renames the bad columns back
  // to the canonical form.
  `CREATE TABLE IF NOT EXISTS system_thresholds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    key_name VARCHAR(100) NOT NULL UNIQUE,
    key_value VARCHAR(200) NOT NULL,
    description VARCHAR(500) DEFAULT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_key_name (key_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Market-close snapshot — last-known per-symbol price written by the
  // 15:30 IST cron (bootInProc.ts) so off-hours resolver requests can
  // serve a stable static answer without burning IndianAPI quota.
  // PRIMARY KEY on symbol → upsert is a single row swap per close.
  `CREATE TABLE IF NOT EXISTS q365_market_close_snapshot (
    symbol           VARCHAR(40)  NOT NULL,
    price            DECIMAL(18,4) NOT NULL,
    change_abs       DECIMAL(18,4) DEFAULT NULL,
    change_pct       DECIMAL(10,4) DEFAULT NULL,
    volume           BIGINT        DEFAULT NULL,
    open_price       DECIMAL(18,4) DEFAULT NULL,
    high_price       DECIMAL(18,4) DEFAULT NULL,
    low_price        DECIMAL(18,4) DEFAULT NULL,
    prev_close       DECIMAL(18,4) DEFAULT NULL,
    snapshot_ts      DATETIME      NOT NULL,
    snapshot_session DATE          NOT NULL,
    created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol),
    INDEX idx_session (snapshot_session)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

// Idempotent column additions for tables that pre-existed before a
// column was added to the inline DDL above. Safe to keep forever —
// `ensureColumn` is a no-op when the column is already present.
const ENSURE_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  // Auth columns required by services/auth.ts. On older DBs the users
  // table was created without these and login fails with
  // "Unknown column 'failed_login_attempts'".
  { table: 'users', column: 'totp_secret',           definition: 'VARCHAR(255) DEFAULT NULL' },
  { table: 'users', column: 'totp_enabled',          definition: 'TINYINT(1) NOT NULL DEFAULT 0' },
  { table: 'users', column: 'failed_login_attempts', definition: 'INT NOT NULL DEFAULT 0' },
  { table: 'users', column: 'locked_until',          definition: 'DATETIME DEFAULT NULL' },
  { table: 'users', column: 'last_login_at',         definition: 'DATETIME DEFAULT NULL' },
  // Session columns required by services/auth.ts createSession.
  { table: 'user_sessions', column: 'device',     definition: 'VARCHAR(255) DEFAULT NULL' },
  { table: 'user_sessions', column: 'ip_address', definition: 'VARCHAR(45) DEFAULT NULL' },
  // News-event ON DUPLICATE KEY UPDATE clause writes updated_at = NOW()
  // (saveNewsEvents.ts:81). Older deployments created the table without it.
  { table: 'q365_news_events', column: 'updated_at', definition: 'DATETIME DEFAULT NULL' },
  // Manual pipeline run-lock: admin override columns added in the
  // IndianAPI cutover. Older deployments need the column ALTER.
  { table: 'q365_pipeline_run_locks', column: 'force_override',  definition: 'TINYINT(1) NOT NULL DEFAULT 0' },
  { table: 'q365_pipeline_run_locks', column: 'override_reason', definition: 'TEXT DEFAULT NULL' },
];

/** Add a column only if it's missing. Mirrors migrateSignalEngine.ts:287. */
async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length === 0) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[ensureAllSchemas] Added column ${table}.${column}`);
  }
}

const SEED_STATEMENTS: Array<{ sql: string; params?: any[] }> = [
  {
    sql: `INSERT IGNORE INTO q365_learning_job_runs (job_name, status, duration_ms, run_at) VALUES
      ('evaluateSignalOutcomes', 'success', 0, NOW()),
      ('updateConfidenceCalibration', 'success', 0, NOW()),
      ('updateStrategyPerformanceSnapshots', 'success', 0, NOW()),
      ('updateAdaptiveRecommendations', 'success', 0, NOW()),
      ('updateManipulationCalibration', 'success', 0, NOW())`,
  },
];

export interface EnsureSchemasResult {
  created: number;
  failed:  number;
  cached:  boolean;  // returned from cache without running DDL this call
}

/**
 * Ensure every table required by the app exists.
 * Runs once per process (cached). Safe to call from any API route.
 * Never throws — logs errors and continues so a single bad DDL doesn't
 * block the entire app from booting.
 *
 * Returns a counts object so callers (CLI wrappers, monitoring) can
 * tell the difference between "all clean" and "30 DDLs failed silently".
 */
export async function ensureAllSchemas(force = false): Promise<EnsureSchemasResult> {
  if (_ensured && !force) {
    return { created: 0, failed: 0, cached: true };
  }

  let created = 0;
  let failed = 0;

  // 1. Run all core DDLs
  for (const ddl of ALL_TABLES) {
    try {
      await db.query(ddl);
      created++;
    } catch (err) {
      failed++;
      const tableName = ddl.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)?.[1] ?? 'unknown';
      console.error(`[ensureAllSchemas] Failed to create ${tableName}:`, (err as Error).message);
    }
  }

  // 2. Idempotent column additions for tables that pre-existed an
  //    inline DDL update. Each entry is a no-op when the column is
  //    already present, so this loop is safe to keep forever.
  for (const c of ENSURE_COLUMNS) {
    try {
      await ensureColumn(c.table, c.column, c.definition);
    } catch (err) {
      failed++;
      console.error(
        `[ensureAllSchemas] ensureColumn ${c.table}.${c.column} failed:`,
        (err as Error).message,
      );
    }
  }

  // 3. Delegate market data tables to their dedicated migration module
  //    (single source of truth — same code path CLI uses)
  try {
    await migrateMarketData();
    created += 2; // candles + market_data_snapshots
  } catch (err) {
    failed++;
    console.error('[ensureAllSchemas] migrateMarketData failed:', (err as Error).message);
  }

  // 4. Apply the signal-engine column migrations on top of the slim
  //    q365_signals DDL above. migrateSignalEngine adds the full
  //    Phase-1/3/4/11 column set (ltp, pct_change, signal_status,
  //    final_score, classification, factor_scores_json, recommended_*,
  //    rejection_codes_json, etc.) via idempotent ALTERs — safe to
  //    run on every boot. Without this step, any writer that targets
  //    those columns (the main pipeline + the custom-universe scanner)
  //    fails with `Unknown column ... in 'field list'`.
  try {
    await migrateSignalEngine();
  } catch (err) {
    failed++;
    console.error('[ensureAllSchemas] migrateSignalEngine failed:', (err as Error).message);
  }

  // 3. Seed minimal rows so dashboards have something to render
  for (const seed of SEED_STATEMENTS) {
    try {
      await db.query(seed.sql, seed.params);
    } catch {
      // seed failures are non-blocking
    }
  }

  console.log(`[ensureAllSchemas] Ready. ${created} DDL executed, ${failed} failed.`);
  // Only cache a CLEAN run. If any DDL failed, leave _ensured=false so
  // the next API call retries — otherwise a transient failure at boot
  // (MySQL not ready, auth flake) permanently poisons the cache and
  // every subsequent request hits "Unknown column / table doesn't exist"
  // errors that Next 14 surfaces as "reading 'bind'" crashes. The cost
  // of re-running when tables already exist is zero (CREATE TABLE IF
  // NOT EXISTS is a no-op after the first success).
  if (failed === 0) {
    _ensured = true;
  } else {
    console.warn(
      `[ensureAllSchemas] NOT caching — ${failed} DDL(s) failed. ` +
      `Next API request will retry.`,
    );
  }
  return { created, failed, cached: false };
}

/** Force re-run on next call (for admin reset endpoint). */
export function resetSchemaCache(): void {
  _ensured = false;
}
