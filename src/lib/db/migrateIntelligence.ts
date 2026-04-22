/**
 * Quantorus365 Intelligence Layer — DB Migration
 * MySQL-native. No PostgreSQL syntax.
 * Run: npx ts-node -r tsconfig-paths/register src/lib/db/migrateIntelligence.ts
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

async function migrateIntelligence() {
  const { getMysqlConnectionConfig } = await import('../db');
  const cfg = getMysqlConnectionConfig();
  const conn = await mysql.createConnection(cfg);
  console.log('Running Quantorus365 Intelligence Layer migrations...\n');
  try {
    await conn.execute(`CREATE TABLE IF NOT EXISTS signal_rules (
      id INT AUTO_INCREMENT PRIMARY KEY, \`key\` VARCHAR(100) UNIQUE NOT NULL,
      label VARCHAR(200) NOT NULL, weight INT DEFAULT 10, enabled TINYINT(1) DEFAULT 1,
      description TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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

    await conn.execute(`CREATE TABLE IF NOT EXISTS signal_history (
      id INT AUTO_INCREMENT PRIMARY KEY, instrument_key VARCHAR(150) NOT NULL,
      tradingsymbol VARCHAR(50) NOT NULL, exchange VARCHAR(20), direction VARCHAR(10) NOT NULL,
      confidence SMALLINT, confidence_score SMALLINT, timeframe VARCHAR(20), risk_level VARCHAR(20),
      score_raw DECIMAL(6,3), entry_price DECIMAL(12,2), stop_loss DECIMAL(12,2),
      target1 DECIMAL(12,2), target2 DECIMAL(12,2), risk_reward DECIMAL(6,2),
      conviction_band VARCHAR(30), market_stance VARCHAR(30), scenario_tag VARCHAR(100),
      portfolio_fit_score SMALLINT, reasons JSON, generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sh_key (instrument_key), INDEX idx_sh_sym (tradingsymbol), INDEX idx_sh_time (generated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ signal_history');

    await conn.execute(`CREATE TABLE IF NOT EXISTS signal_performance (
      id INT AUTO_INCREMENT PRIMARY KEY, signal_id INT NULL, instrument_key VARCHAR(150),
      direction VARCHAR(10), entry_price DECIMAL(12,2), target1 DECIMAL(12,2),
      stop_loss DECIMAL(12,2), exit_price DECIMAL(12,2), outcome VARCHAR(20),
      pnl_pct DECIMAL(8,4), conviction_band VARCHAR(30),
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sp_key (instrument_key), INDEX idx_sp_outcome (outcome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ signal_performance');

    await conn.execute(`CREATE TABLE IF NOT EXISTS trade_setups (
      id INT AUTO_INCREMENT PRIMARY KEY, instrument_key VARCHAR(150), tradingsymbol VARCHAR(50) NOT NULL,
      exchange VARCHAR(20), direction VARCHAR(10), entry_price DECIMAL(12,2), stop_loss DECIMAL(12,2),
      target1 DECIMAL(12,2), target2 DECIMAL(12,2), risk_reward DECIMAL(6,2), confidence SMALLINT,
      timeframe VARCHAR(20), reason TEXT, scenario_tag VARCHAR(100), regime VARCHAR(30),
      status VARCHAR(20) DEFAULT 'active', triggered_at DATETIME, expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ts_sym (tradingsymbol), INDEX idx_ts_status (status), INDEX idx_ts_exp (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ trade_setups');

    await conn.execute(`CREATE TABLE IF NOT EXISTS alert_events (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, instrument_key VARCHAR(150),
      tradingsymbol VARCHAR(50), alert_type VARCHAR(50), message TEXT, data JSON, read_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ae_user (user_id), INDEX idx_ae_sym (tradingsymbol), INDEX idx_ae_time (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ alert_events');

    await conn.execute(`CREATE TABLE IF NOT EXISTS user_alert_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT UNIQUE NOT NULL,
      min_confidence SMALLINT DEFAULT 65, price_alerts TINYINT(1) DEFAULT 1,
      signal_alerts TINYINT(1) DEFAULT 1, volume_spike TINYINT(1) DEFAULT 1,
      oi_spike TINYINT(1) DEFAULT 0, watchlist_opp TINYINT(1) DEFAULT 1,
      email_alerts TINYINT(1) DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ user_alert_preferences');

    await conn.execute(`CREATE TABLE IF NOT EXISTS watchlist_scores (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, instrument_key VARCHAR(150) NOT NULL,
      tradingsymbol VARCHAR(50), opportunity_score SMALLINT, signal_direction VARCHAR(10),
      signal_confidence SMALLINT, momentum_label VARCHAR(30), risk_level VARCHAR(20),
      reason_summary TEXT, scored_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ws (user_id, instrument_key), INDEX idx_ws_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ watchlist_scores');

    await conn.execute(`CREATE TABLE IF NOT EXISTS trade_journal (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, tradingsymbol VARCHAR(50) NOT NULL,
      exchange VARCHAR(20), direction VARCHAR(10) NOT NULL, entry_price DECIMAL(12,2) NOT NULL,
      exit_price DECIMAL(12,2), quantity INT NOT NULL, entry_date DATETIME NOT NULL,
      exit_date DATETIME, strategy VARCHAR(100), timeframe VARCHAR(20), notes TEXT,
      outcome VARCHAR(20), pnl DECIMAL(12,2), pnl_pct DECIMAL(8,4),
      emotion_entry VARCHAR(50), emotion_exit VARCHAR(50), tags JSON,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tj_user (user_id, entry_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ trade_journal');

    await conn.execute(`CREATE TABLE IF NOT EXISTS trader_analytics_snapshots (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT UNIQUE NOT NULL,
      total_trades INT DEFAULT 0, wins INT DEFAULT 0, losses INT DEFAULT 0,
      win_rate DECIMAL(6,2), avg_rr DECIMAL(6,2), avg_hold_hours DECIMAL(8,2),
      best_day VARCHAR(10), worst_day VARCHAR(10), best_timeframe VARCHAR(20),
      common_mistake TEXT, patterns JSON, computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ trader_analytics_snapshots');

    await conn.execute(`CREATE TABLE IF NOT EXISTS user_plans (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id INT UNIQUE NOT NULL,
      plan VARCHAR(20) DEFAULT 'free', started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS feature_entitlements (
      id INT AUTO_INCREMENT PRIMARY KEY, plan VARCHAR(20) NOT NULL,
      feature_key VARCHAR(100) NOT NULL, enabled TINYINT(1) DEFAULT 1,
      UNIQUE KEY uq_fe (plan, feature_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await conn.execute(`INSERT IGNORE INTO feature_entitlements (plan,feature_key,enabled) VALUES
      ('free','signals_basic',1),('free','signals_advanced',0),('free','trade_setups',0),
      ('free','smart_watchlist',0),('free','option_intelligence',0),('free','market_explanation',1),
      ('free','trader_analytics',0),
      ('pro','signals_basic',1),('pro','signals_advanced',1),('pro','trade_setups',1),
      ('pro','smart_watchlist',1),('pro','option_intelligence',1),('pro','market_explanation',1),
      ('pro','trader_analytics',0),
      ('elite','signals_basic',1),('elite','signals_advanced',1),('elite','trade_setups',1),
      ('elite','smart_watchlist',1),('elite','option_intelligence',1),('elite','market_explanation',1),
      ('elite','trader_analytics',1)`);
    console.log('✓ user_plans + feature_entitlements');

    await conn.execute(`CREATE TABLE IF NOT EXISTS explanation_cache (
      id INT AUTO_INCREMENT PRIMARY KEY, cache_key VARCHAR(200) UNIQUE NOT NULL,
      payload JSON NOT NULL, generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ec_key (cache_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ explanation_cache');

    await conn.execute(`CREATE TABLE IF NOT EXISTS strategy_performance (
      id INT AUTO_INCREMENT PRIMARY KEY, strategy_key VARCHAR(100) NOT NULL,
      regime VARCHAR(30), confidence_band VARCHAR(20), period_start DATE, period_end DATE,
      signals_total INT DEFAULT 0, signals_win INT DEFAULT 0, signals_loss INT DEFAULT 0,
      hit_rate DECIMAL(5,1),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sp (strategy_key, regime, confidence_band, period_start),
      INDEX idx_sp_strategy (strategy_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ strategy_performance');

    await conn.execute(`CREATE TABLE IF NOT EXISTS signal_quality_events (
      id INT AUTO_INCREMENT PRIMARY KEY, instrument_key VARCHAR(150), tradingsymbol VARCHAR(50),
      event_type VARCHAR(50) NOT NULL, details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sqe_sym (tradingsymbol), INDEX idx_sqe_type (event_type), INDEX idx_sqe_time (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('✓ signal_quality_events');

    console.log('\n✅ Intelligence layer migration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

migrateIntelligence();
