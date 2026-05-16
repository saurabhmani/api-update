/**
 * Quantorus365 — Full Database Setup
 *
 * Creates the database (if not exists) + runs all migrations + seeds users.
 * Compatible with MariaDB and MySQL.
 *
 * Run: npm run db:setup
 */
import mysql from 'mysql2/promise';
import fs    from 'fs';
import path  from 'path';

// ── Load .env.local ───────────────────────────────────────────────
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

async function setup() {
  let cfg;
  try {
    const { getMysqlConnectionConfig } = await import('../db');
    cfg = getMysqlConnectionConfig();
  } catch (err: any) {
    console.error(`❌ ${err?.message ?? err}`);
    console.error('   Set MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE in .env.local');
    process.exit(1);
  }
  const { host, port, user, password, database: dbName } = cfg;

  console.log(`\n🚀 Quantorus365 Database Setup`);
  console.log(`   Host:     ${host}:${port}`);
  console.log(`   Database: ${dbName}`);
  console.log(`   User:     ${user}\n`);

  // ── Step 1: Create database ───────────────────────────────────
  console.log('── Step 1: Creating database ─────────────────────────');
  const rootConn = await mysql.createConnection({ host, port, user, password });
  await rootConn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  console.log(`✓ Database '${dbName}' ready\n`);
  await rootConn.end();

  // Connect to the database for all migrations
  const conn = await mysql.createConnection({ host, port, user, password, database: dbName, multipleStatements: true });

  try {
    // ── Step 2: Base tables ───────────────────────────────────────
    console.log('── Step 2: Base tables ───────────────────────────────');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        email                 VARCHAR(255) UNIQUE NOT NULL,
        name                  VARCHAR(255),
        password_hash         VARCHAR(255) NOT NULL,
        role                  VARCHAR(20)  DEFAULT 'user',
        is_active             TINYINT(1)   DEFAULT 1,
        totp_secret           VARCHAR(255),
        totp_enabled          TINYINT(1)   DEFAULT 0,
        failed_login_attempts INT          DEFAULT 0,
        locked_until          DATETIME,
        last_login_at         DATETIME,
        created_at            DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at            DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_users_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ users');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        token      VARCHAR(255) UNIQUE NOT NULL,
        device     VARCHAR(255),
        ip_address VARCHAR(50),
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sessions_token (token),
        INDEX idx_sessions_user  (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ user_sessions');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        used       TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ password_resets');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_id       INT,
        action        VARCHAR(100) NOT NULL,
        resource_type VARCHAR(100),
        resource_id   INT,
        metadata      JSON,
        ip_address    VARCHAR(50),
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_user   (user_id),
        INDEX idx_audit_action (action),
        INDEX idx_audit_time   (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ audit_logs');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS instruments (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key  VARCHAR(150) UNIQUE NOT NULL,
        exchange        VARCHAR(20)  NOT NULL,
        tradingsymbol   VARCHAR(50)  NOT NULL,
        name            VARCHAR(255),
        expiry          DATE,
        strike          DECIMAL(12,2),
        tick_size       DECIMAL(10,4),
        lot_size        INT,
        instrument_type VARCHAR(30),
        option_type     VARCHAR(5),
        isin            VARCHAR(20),
        sector          VARCHAR(100),
        raw_json        JSON,
        is_active       TINYINT(1)   DEFAULT 1,
        last_synced_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
        created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_instruments_symbol   (tradingsymbol),
        INDEX idx_instruments_exchange (exchange),
        INDEX idx_instruments_type     (instrument_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ instruments');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS watchlists (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        name       VARCHAR(100) DEFAULT 'Default',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_wl_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS watchlist_items (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        watchlist_id   INT NOT NULL,
        instrument_key VARCHAR(150) NOT NULL,
        tradingsymbol  VARCHAR(50),
        exchange       VARCHAR(20),
        name           VARCHAR(255),
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_wi (watchlist_id, instrument_key),
        INDEX idx_wi_wl (watchlist_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ watchlists + watchlist_items');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolios (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        name       VARCHAR(100) DEFAULT 'My Portfolio',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_portfolios_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_positions (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id   INT NOT NULL,
        instrument_id  INT,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50) NOT NULL,
        exchange       VARCHAR(20),
        quantity       INT NOT NULL,
        buy_price      DECIMAL(12,2) NOT NULL,
        avg_cost       DECIMAL(12,2),
        current_price  DECIMAL(12,2),
        market_value   DECIMAL(14,2),
        unrealized_pnl DECIMAL(14,2),
        realized_pnl   DECIMAL(14,2) DEFAULT 0,
        as_of          DATETIME,
        added_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_pp_portfolio     (portfolio_id),
        INDEX idx_pp_instrument_id (instrument_id),
        INDEX idx_pp_symbol        (tradingsymbol)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ portfolios + portfolio_positions');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS rankings (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key      VARCHAR(150),
        tradingsymbol       VARCHAR(50),
        exchange            VARCHAR(20),
        name                VARCHAR(255),
        score               DECIMAL(8,4),
        rank_position       INT,
        pct_change          DECIMAL(8,4),
        ltp                 DECIMAL(12,2),
        volume              BIGINT,
        confidence_score    SMALLINT,
        portfolio_fit_score SMALLINT,
        conviction_band     VARCHAR(30),
        market_stance       VARCHAR(30),
        scenario_tag        VARCHAR(100),
        updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_rankings_sym   (tradingsymbol),
        INDEX idx_rankings_score (score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ rankings');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signals (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key      VARCHAR(150),
        tradingsymbol       VARCHAR(50),
        signal_type         VARCHAR(50),
        strength            VARCHAR(20),
        description         TEXT,
        confidence          SMALLINT,
        confidence_score    SMALLINT,
        risk_score          SMALLINT,
        scenario_tag        VARCHAR(100),
        market_stance       VARCHAR(30),
        regime              VARCHAR(30),
        conviction_band     VARCHAR(30),
        portfolio_fit_score SMALLINT,
        regime_alignment    SMALLINT,
        rejection_json      JSON,
        generated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_signals_sym  (tradingsymbol),
        INDEX idx_signals_time (generated_at),
        INDEX idx_signals_conf (confidence_score)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ signals');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS candles (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150) NOT NULL,
        candle_type    VARCHAR(15)  NOT NULL,
        interval_unit  VARCHAR(20)  NOT NULL,
        ts             DATETIME     NOT NULL,
        open           DECIMAL(12,2) DEFAULT NULL,
        high           DECIMAL(12,2) DEFAULT NULL,
        low            DECIMAL(12,2) DEFAULT NULL,
        close          DECIMAL(12,2) DEFAULT NULL,
        volume         BIGINT        DEFAULT 0,
        oi             BIGINT        DEFAULT 0,
        UNIQUE KEY uq_candle (instrument_key, candle_type, interval_unit, ts),
        INDEX idx_candles_key_ts (instrument_key, ts)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ candles');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS market_data_snapshots (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        symbol         VARCHAR(50)   NOT NULL,
        instrument_key VARCHAR(150)  NOT NULL,
        ltp            DECIMAL(12,2) DEFAULT 0,
        open_price     DECIMAL(12,2) DEFAULT 0,
        high_price     DECIMAL(12,2) DEFAULT 0,
        low_price      DECIMAL(12,2) DEFAULT 0,
        close_price    DECIMAL(12,2) DEFAULT 0,
        volume         BIGINT        DEFAULT 0,
        oi             BIGINT        DEFAULT 0,
        change_percent DECIMAL(8,4)  DEFAULT 0,
        change_abs     DECIMAL(12,2) DEFAULT 0,
        vwap           DECIMAL(12,2) DEFAULT NULL,
        source         VARCHAR(20)   DEFAULT 'nse',
        snapshot_ts    BIGINT        DEFAULT 0,
        updated_at     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_snapshot_symbol (symbol),
        INDEX idx_snap_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ market_data_snapshots');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS macro_data (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        indicator  VARCHAR(100) NOT NULL,
        value      DECIMAL(14,4),
        unit       VARCHAR(50),
        period     VARCHAR(50),
        source     VARCHAR(100),
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_macro_indicator (indicator)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ macro_data');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signal_rejections (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        signal_id           INT           NULL,
        symbol              VARCHAR(50)   NOT NULL,
        strategy_code       VARCHAR(100),
        regime_code         VARCHAR(30),
        confidence_score    SMALLINT,
        risk_score          SMALLINT,
        rr_ratio            DECIMAL(6,2),
        liquidity_score     SMALLINT,
        portfolio_fit_score SMALLINT,
        approved            TINYINT(1)    DEFAULT 0,
        rejection_reason_json JSON,
        created_at          DATETIME      DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sr_symbol   (symbol),
        INDEX idx_sr_approved (approved),
        INDEX idx_sr_created  (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ signal_rejections');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS system_thresholds (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        key_name    VARCHAR(100) UNIQUE NOT NULL,
        key_value   VARCHAR(100)        NOT NULL,
        description TEXT,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_key_name (key_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const seeds = [
      ['MIN_RR_SWING','2.0'],['MIN_RR_POSITIONAL','2.5'],['MIN_CONFIDENCE','65'],
      ['MIN_COMPOSITE_SCORE','45'],['MAX_RISK_SCORE','75'],['MIN_DATA_QUALITY','0.40'],
      ['MIN_LIQUIDITY_VOLUME','100000'],['MIN_VOLUME_INTRADAY','10000'],
      ['MAX_SECTOR_EXPOSURE','30'],['MAX_POSITIONS','12'],
      ['MAX_STRATEGY_CONCENTRATION','0.50'],['MAX_CORRELATION','0.75'],
      ['MIN_PORTFOLIO_FIT','40'],['MAX_DRAWDOWN_BLOCK','15'],['CAPITAL_AT_RISK_CAP','20'],
      ['MAX_STOP_ATR_MULTIPLE','3.5'],['MIN_STOP_ATR_MULTIPLE','0.5'],
      ['WEIGHT_FACTOR_ALIGNMENT','0.22'],['WEIGHT_STRATEGY_CLARITY','0.14'],
      ['WEIGHT_REGIME_ALIGNMENT','0.14'],['WEIGHT_LIQUIDITY','0.10'],
      ['WEIGHT_DATA_QUALITY','0.08'],['WEIGHT_PORTFOLIO_FIT','0.12'],
      ['WEIGHT_PARTICIPATION','0.06'],['WEIGHT_RR_QUALITY','0.08'],
      ['WEIGHT_VOLATILITY_FIT','0.06'],['CORRELATION_LOOKBACK_DAYS','60'],
    ];
    for (const [k, v] of seeds) {
      await conn.execute(
        `INSERT IGNORE INTO system_thresholds (key_name, key_value) VALUES (?, ?)`, [k, v]
      );
    }
    console.log('✓ system_thresholds');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS market_scenarios (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        scenario_date       DATE     DEFAULT (CURDATE()),
        scenario_tag        VARCHAR(50) NOT NULL,
        scenario_confidence SMALLINT,
        breadth_state       VARCHAR(30),
        volatility_state    VARCHAR(20),
        created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ms_date (scenario_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ market_scenarios');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS market_stance_logs (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        stance_date        DATE     DEFAULT (CURDATE()),
        market_stance      VARCHAR(30) NOT NULL,
        stance_confidence  SMALLINT,
        scenario_tag       VARCHAR(50),
        rejection_rate     DECIMAL(5,2),
        avg_top_confidence SMALLINT,
        created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_msl_date (stance_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ market_stance_logs');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signal_rules (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        \`key\`     VARCHAR(100) UNIQUE NOT NULL,
        label       VARCHAR(200) NOT NULL,
        weight      INT DEFAULT 10,
        enabled     TINYINT(1) DEFAULT 1,
        description TEXT,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`INSERT IGNORE INTO signal_rules (\`key\`,label,weight,enabled,description) VALUES
      ('price_vs_vwap','Price vs VWAP',15,1,'Bullish above VWAP'),
      ('price_vs_sma20','Price vs 20-day SMA',12,1,'Trend direction'),
      ('volume_expansion','Volume Expansion',13,1,'Conviction'),
      ('near_52w_high','Near 52-Week High',8,1,'Breakout proximity'),
      ('above_prev_close','Above Previous Close',10,1,'Day bias'),
      ('momentum_pct','Price Momentum',12,1,'Intraday strength'),
      ('delivery_pct','Delivery Percentage',8,1,'Institutional conviction'),
      ('week_trend','5-Day Trend',10,1,'Medium-term structure'),
      ('oi_buildup','OI Build-Up',7,1,'Option positioning context'),
      ('iv_context','Implied Volatility',5,1,'Premium environment context')`);
    console.log('✓ signal_rules');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS trade_setups (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50) NOT NULL,
        exchange       VARCHAR(20),
        direction      VARCHAR(10),
        entry_price    DECIMAL(12,2),
        stop_loss      DECIMAL(12,2),
        target1        DECIMAL(12,2),
        target2        DECIMAL(12,2),
        risk_reward    DECIMAL(6,2),
        confidence     SMALLINT,
        timeframe      VARCHAR(20),
        reason         TEXT,
        scenario_tag   VARCHAR(100),
        regime         VARCHAR(30),
        status         VARCHAR(20) DEFAULT 'active',
        expires_at     DATETIME,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ts_sym    (tradingsymbol),
        INDEX idx_ts_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ trade_setups');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS trade_journal (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        user_id       INT NOT NULL,
        tradingsymbol VARCHAR(50) NOT NULL,
        exchange      VARCHAR(20),
        direction     VARCHAR(10) NOT NULL,
        entry_price   DECIMAL(12,2) NOT NULL,
        exit_price    DECIMAL(12,2),
        quantity      INT NOT NULL,
        entry_date    DATETIME NOT NULL,
        exit_date     DATETIME,
        strategy      VARCHAR(100),
        timeframe     VARCHAR(20),
        notes         TEXT,
        outcome       VARCHAR(20),
        pnl           DECIMAL(12,2),
        pnl_pct       DECIMAL(8,4),
        tags          JSON,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tj_user (user_id, entry_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ trade_journal');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        user_id           INT UNIQUE NOT NULL,
        default_dashboard VARCHAR(50) DEFAULT 'overview',
        timezone          VARCHAR(100) DEFAULT 'Asia/Kolkata',
        alert_email       TINYINT(1) DEFAULT 1,
        preferences       JSON,
        updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ user_preferences');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) UNIQUE NOT NULL,
        enabled    TINYINT(1) DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`INSERT IGNORE INTO feature_flags (name, enabled) VALUES
      ('live_feed',0),('options_chain',0),('ai_signals',0)`);
    console.log('✓ feature_flags');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_plans (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT UNIQUE NOT NULL,
        plan       VARCHAR(20) DEFAULT 'free',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS feature_entitlements (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        plan        VARCHAR(20)  NOT NULL,
        feature_key VARCHAR(100) NOT NULL,
        enabled     TINYINT(1) DEFAULT 1,
        UNIQUE KEY uq_fe (plan, feature_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`INSERT IGNORE INTO feature_entitlements (plan,feature_key,enabled) VALUES
      ('free','signals_basic',1),('free','signals_advanced',0),('free','market_explanation',1),
      ('pro','signals_basic',1),('pro','signals_advanced',1),('pro','trade_setups',1),
      ('pro','smart_watchlist',1),('pro','option_intelligence',1),('pro','market_explanation',1),
      ('elite','signals_basic',1),('elite','signals_advanced',1),('elite','trade_setups',1),
      ('elite','smart_watchlist',1),('elite','option_intelligence',1),('elite','trader_analytics',1)`);
    console.log('✓ user_plans + feature_entitlements');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS alerts (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        user_id        INT NOT NULL,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50),
        condition_type VARCHAR(20) DEFAULT 'above',
        target_price   DECIMAL(12,2),
        is_active      TINYINT(1) DEFAULT 1,
        triggered_at   DATETIME,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_alerts_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        message    TEXT NOT NULL,
        type       VARCHAR(50) DEFAULT 'info',
        is_read    TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_notif_user (user_id, is_read)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ alerts + notifications');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS strategy_performance (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        strategy_key    VARCHAR(100) NOT NULL,
        regime          VARCHAR(30),
        confidence_band VARCHAR(20),
        period_start    DATE,
        period_end      DATE,
        signals_total   INT DEFAULT 0,
        signals_win     INT DEFAULT 0,
        signals_loss    INT DEFAULT 0,
        hit_rate        DECIMAL(5,1),
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sp (strategy_key, regime, confidence_band, period_start)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS signal_quality_events (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        instrument_key VARCHAR(150),
        tradingsymbol  VARCHAR(50),
        event_type     VARCHAR(50) NOT NULL,
        details        TEXT,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sqe_sym  (tradingsymbol),
        INDEX idx_sqe_type (event_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS explanation_cache (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        cache_key    VARCHAR(200) UNIQUE NOT NULL,
        payload      JSON NOT NULL,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ec_key (cache_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ strategy_performance + signal_quality_events + explanation_cache');

    // ── Step 3: Seed admin user ───────────────────────────────────
    // Passwords are read from .env.local. Required env vars:
    //   SEED_ADMIN_PASSWORD, SEED_JOHN_PASSWORD, SEED_PRIYA_PASSWORD
    // If any is missing, that user is skipped — we NEVER fall back
    // to a hardcoded default.
    console.log('\n── Step 3: Seeding users ─────────────────────────────');
    const bcrypt = require('bcryptjs');

    const USERS = [
      { email: 'admin@quantorus365.in', name: 'Admin',      envKey: 'SEED_ADMIN_PASSWORD', role: 'admin' },
      { email: 'john@quantorus365.in',  name: 'John Doe',   envKey: 'SEED_JOHN_PASSWORD',  role: 'user'  },
      { email: 'priya@quantorus365.in', name: 'Priya Shah', envKey: 'SEED_PRIYA_PASSWORD', role: 'user'  },
    ];

    for (const u of USERS) {
      const pwd = process.env[u.envKey];
      if (!pwd || pwd.length < 8) {
        console.log(`⏭  Skipped  ${u.email}  (${u.envKey} missing or < 8 chars in .env.local)`);
        continue;
      }
      const hash = await bcrypt.hash(pwd, 12);
      await conn.execute(
        `INSERT IGNORE INTO users (email, name, password_hash, role, is_active) VALUES (?, ?, ?, ?, 1)`,
        [u.email, u.name, hash, u.role]
      );
      console.log(`✓ ${u.email}  [${u.role}]  password source: ${u.envKey}`);
    }

    console.log(`
✅ Setup complete!

   Login at http://localhost:3000
   Email:    admin@quantorus365.in
   Password: (set via SEED_ADMIN_PASSWORD in .env.local)

   Next steps:
     npm run dev          → start the app
`);

  } catch (err: any) {
    console.error('\n❌ Setup failed:', err?.message ?? err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

setup();
