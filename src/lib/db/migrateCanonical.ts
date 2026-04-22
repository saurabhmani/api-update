/**
 * Quantorus365 — Canonical Data Layer Migration
 *
 * Creates Phase 1 tables: sectors, benchmarks, factors, transactions,
 * and extends portfolios + instruments with canonical columns.
 *
 * MySQL-native. Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 * Run: npx ts-node -r tsconfig-paths/register src/lib/db/migrateCanonical.ts
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'migrateCanonical' });

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

/** Safe ADD COLUMN — ignores "Duplicate column" error */
async function addColumn(conn: mysql.Connection, table: string, column: string, def: string): Promise<void> {
  try {
    await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    log.info('Added column', { table, column });
  } catch (err: any) {
    if (err?.code === 'ER_DUP_FIELDNAME' || err?.errno === 1060) return;
    throw err;
  }
}

async function migrate() {
  const { getMysqlConnectionConfig } = await import('../db');
  const cfg = getMysqlConnectionConfig();
  const conn = await mysql.createConnection(cfg);

  log.info('Running canonical data layer migrations');

  try {
    // ── Sectors ────────────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS sectors (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'sectors' });

    // Seed common Indian market sectors
    await conn.execute(`
      INSERT IGNORE INTO sectors (name) VALUES
        ('Information Technology'), ('Financial Services'), ('Healthcare'),
        ('Consumer Goods'), ('Automobile'), ('Energy'), ('Metals & Mining'),
        ('Pharma'), ('Cement & Construction'), ('Telecom'),
        ('Chemicals'), ('Power'), ('Real Estate'), ('Media & Entertainment'),
        ('FMCG'), ('Capital Goods'), ('Infrastructure'), ('Textiles'),
        ('Fertilizers'), ('Shipping & Ports')
    `);
    log.info('Seeded sectors');

    // ── Benchmarks ─────────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS benchmarks (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(200) NOT NULL,
        ticker     VARCHAR(50) UNIQUE NOT NULL,
        asset_type VARCHAR(30) DEFAULT 'index',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'benchmarks' });

    // Seed NSE indices
    await conn.execute(`
      INSERT IGNORE INTO benchmarks (name, ticker, asset_type) VALUES
        ('NIFTY 50',          'NSE:NIFTY 50',       'index'),
        ('NIFTY Bank',        'NSE:NIFTY BANK',     'index'),
        ('NIFTY IT',          'NSE:NIFTY IT',       'index'),
        ('NIFTY Next 50',     'NSE:NIFTY NEXT 50',  'index'),
        ('NIFTY Midcap 150',  'NSE:NIFTY MIDCAP 150', 'index'),
        ('NIFTY Smallcap 250','NSE:NIFTY SMLCAP 250', 'index'),
        ('NIFTY Pharma',      'NSE:NIFTY PHARMA',   'index'),
        ('NIFTY Auto',        'NSE:NIFTY AUTO',     'index'),
        ('NIFTY Financial Services', 'NSE:NIFTY FIN SERVICE', 'index'),
        ('NIFTY Metal',       'NSE:NIFTY METAL',    'index')
    `);
    log.info('Seeded benchmarks');

    // ── Factors ────────────────────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS factors (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) UNIQUE NOT NULL,
        category   VARCHAR(50) NOT NULL DEFAULT 'style',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_factors_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'factors' });

    await conn.execute(`
      INSERT IGNORE INTO factors (name, category) VALUES
        ('Momentum',      'style'),
        ('Value',         'style'),
        ('Quality',       'style'),
        ('Low Volatility','style'),
        ('Size',          'style'),
        ('Growth',        'style'),
        ('Dividend Yield','style'),
        ('Beta',          'technical'),
        ('RSI',           'technical'),
        ('MACD',          'technical'),
        ('Interest Rate', 'macro'),
        ('Inflation',     'macro'),
        ('FII Flow',      'macro'),
        ('DII Flow',      'macro'),
        ('PE Ratio',      'fundamental'),
        ('ROE',           'fundamental'),
        ('Debt-to-Equity','fundamental'),
        ('EPS Growth',    'fundamental')
    `);
    log.info('Seeded factors');

    // ── Transactions (canonical trade log) ─────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id  INT NOT NULL,
        instrument_id INT,
        ticker        VARCHAR(50) NOT NULL,
        side          ENUM('buy', 'sell') NOT NULL,
        quantity      INT NOT NULL,
        price         DECIMAL(12,2) NOT NULL,
        fees          DECIMAL(10,2) DEFAULT 0,
        executed_at   DATETIME NOT NULL,
        source        VARCHAR(50) DEFAULT 'manual',
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_txn_portfolio (portfolio_id),
        INDEX idx_txn_ticker    (ticker),
        INDEX idx_txn_executed  (executed_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'transactions' });

    // ── Extend portfolios with canonical columns ───────────────────
    await addColumn(conn, 'portfolios', 'owner_type',     "VARCHAR(30) DEFAULT 'individual'");
    await addColumn(conn, 'portfolios', 'base_currency',  "VARCHAR(5) DEFAULT 'INR'");
    await addColumn(conn, 'portfolios', 'benchmark_id',   'INT');
    await addColumn(conn, 'portfolios', 'strategy_type',  'VARCHAR(50)');
    await addColumn(conn, 'portfolios', 'updated_at',     'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    // ── Extend instruments with canonical columns ──────────────────
    await addColumn(conn, 'instruments', 'industry',      'VARCHAR(100)');
    await addColumn(conn, 'instruments', 'currency',      "VARCHAR(5) DEFAULT 'INR'");
    await addColumn(conn, 'instruments', 'asset_type',    "VARCHAR(30) DEFAULT 'EQ'");
    await addColumn(conn, 'instruments', 'status',        "VARCHAR(20) DEFAULT 'active'");
    await addColumn(conn, 'instruments', 'sector_id',     'INT');
    await addColumn(conn, 'instruments', 'updated_at',    'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

    // ── Extend portfolio_positions with canonical columns ──────────
    await addColumn(conn, 'portfolio_positions', 'instrument_id',  'INT');
    await addColumn(conn, 'portfolio_positions', 'avg_cost',       'DECIMAL(12,2)');
    await addColumn(conn, 'portfolio_positions', 'market_value',   'DECIMAL(14,2)');
    await addColumn(conn, 'portfolio_positions', 'unrealized_pnl', 'DECIMAL(14,2)');
    await addColumn(conn, 'portfolio_positions', 'realized_pnl',   'DECIMAL(14,2) DEFAULT 0');
    await addColumn(conn, 'portfolio_positions', 'as_of',          'DATETIME');

    // ── Backfill: populate instrument_id from instruments table ────
    // Ensures JOINs can use instrument_id instead of tradingsymbol.
    try {
      await conn.execute(`
        UPDATE portfolio_positions pp
        JOIN instruments i ON pp.tradingsymbol = i.tradingsymbol
          AND i.exchange = COALESCE(pp.exchange, 'NSE')
          AND i.is_active = 1
        SET pp.instrument_id = i.id
        WHERE pp.instrument_id IS NULL
      `);
      log.info('Backfilled portfolio_positions.instrument_id');
    } catch (err) {
      log.warn('instrument_id backfill skipped', { error: (err as Error).message });
    }

    // ── Index for instrument_id join on portfolio_positions ────────
    try {
      await conn.execute('ALTER TABLE portfolio_positions ADD INDEX idx_pp_instrument_id (instrument_id)');
    } catch {
      // Index already exists
    }

    // ── Portfolio snapshots (Phase 2 — as-of reproducibility) ──────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id    INT NOT NULL,
        snapshot_date   DATE NOT NULL,
        total_value     DECIMAL(16,2) NOT NULL,
        invested_value  DECIMAL(16,2) NOT NULL,
        pnl             DECIMAL(16,2) NOT NULL,
        pnl_pct         DECIMAL(8,4) DEFAULT 0,
        positions_count INT DEFAULT 0,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_portfolio_snapshot (portfolio_id, snapshot_date),
        INDEX idx_ps_portfolio (portfolio_id),
        INDEX idx_ps_date (snapshot_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'portfolio_snapshots' });

    // ── Governance rules (Phase 6) ───────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS governance_rules (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(200) NOT NULL,
        rule_type   VARCHAR(50) NOT NULL,
        description TEXT,
        parameters  JSON,
        is_active   TINYINT(1) DEFAULT 1,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_gr_type (rule_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'governance_rules' });

    // Seed default governance rules
    await conn.execute(`
      INSERT IGNORE INTO governance_rules (name, rule_type, description, parameters) VALUES
        ('Restricted Instruments', 'restriction', 'Block trades in restricted/banned instruments', '{}'),
        ('Max Allocation Per Instrument', 'max_allocation', 'No single instrument above 20% of AUM', '{"max_pct": 20}'),
        ('Max Sector Allocation', 'max_sector', 'No single sector above 35% of AUM', '{"max_pct": 35}'),
        ('Strategy Eligibility', 'strategy_eligibility', 'Only approved strategies', '{"approved": ["swing", "positional", "momentum", "breakout"]}'),
        ('Turnover Threshold', 'turnover', 'Max 5 trades per day', '{"max_daily_trades": 5}'),
        ('Client Exclusions', 'client_exclusion', 'Account-specific instrument exclusions', '{}')
    `);
    log.info('Seeded governance rules');

    // ── Governance restrictions ────────────────────────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS governance_restrictions (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        ticker           VARCHAR(50),
        sector           VARCHAR(100),
        restriction_type ENUM('banned', 'max_allocation', 'sell_only', 'excluded') NOT NULL,
        reason           TEXT,
        portfolio_id     INT,
        is_active        TINYINT(1) DEFAULT 1,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_gres_ticker (ticker),
        INDEX idx_gres_sector (sector),
        INDEX idx_gres_portfolio (portfolio_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'governance_restrictions' });

    // ── Portfolio breaches (Phase 9 — monitoring) ───────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS portfolio_breaches (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        portfolio_id    INT NOT NULL,
        category        VARCHAR(50) NOT NULL,
        severity        VARCHAR(20) NOT NULL,
        metric          VARCHAR(100) NOT NULL,
        current_value   DECIMAL(14,4),
        threshold       DECIMAL(14,4),
        message         TEXT,
        source          VARCHAR(50),
        detected_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        acknowledged    TINYINT(1) DEFAULT 0,
        acknowledged_at DATETIME,
        UNIQUE KEY uq_breach (portfolio_id, metric),
        INDEX idx_breach_portfolio (portfolio_id),
        INDEX idx_breach_severity (severity),
        INDEX idx_breach_ack (acknowledged)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'portfolio_breaches' });

    // ── Audit events (Phase 10 — compliance-grade) ─────────────────
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        event_type    VARCHAR(100) NOT NULL,
        actor_id      INT,
        actor_type    VARCHAR(30) DEFAULT 'user',
        decision_id   VARCHAR(50),
        portfolio_id  INT,
        instrument_id INT,
        resource_type VARCHAR(100),
        resource_id   VARCHAR(100),
        action        VARCHAR(100) NOT NULL,
        details       JSON,
        ip_address    VARCHAR(50),
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ae_type (event_type),
        INDEX idx_ae_actor (actor_id),
        INDEX idx_ae_decision (decision_id),
        INDEX idx_ae_portfolio (portfolio_id),
        INDEX idx_ae_instrument (instrument_id),
        INDEX idx_ae_resource (resource_type, resource_id),
        INDEX idx_ae_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'audit_events' });

    // ── Backfill: add compliance columns if table already existed ──
    for (const col of [
      { name: 'decision_id',   def: 'VARCHAR(50) AFTER actor_type' },
      { name: 'portfolio_id',  def: 'INT AFTER decision_id' },
      { name: 'instrument_id', def: 'INT AFTER portfolio_id' },
    ]) {
      try {
        await conn.execute(`ALTER TABLE audit_events ADD COLUMN ${col.name} ${col.def}`);
        log.info('Added column to audit_events', { column: col.name });
      } catch {
        // Column already exists — expected on fresh installs
      }
    }
    // Ensure indexes exist for the new columns
    for (const idx of [
      { name: 'idx_ae_decision',   cols: '(decision_id)' },
      { name: 'idx_ae_portfolio',  cols: '(portfolio_id)' },
      { name: 'idx_ae_instrument', cols: '(instrument_id)' },
    ]) {
      try {
        await conn.execute(`ALTER TABLE audit_events ADD INDEX ${idx.name} ${idx.cols}`);
      } catch {
        // Index already exists
      }
    }

    // ── Decision traces (Phase 10 — institutional explainability) ──
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS decision_traces (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        decision_id       VARCHAR(50) UNIQUE NOT NULL,
        ticker            VARCHAR(50) NOT NULL,
        side              VARCHAR(10) NOT NULL,
        decision          VARCHAR(50) NOT NULL,
        fit_score         SMALLINT,
        risk_score        SMALLINT,
        governance_status VARCHAR(20),
        scenario_impact   DECIMAL(8,2),
        trace_json        JSON NOT NULL,
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dt_ticker (ticker),
        INDEX idx_dt_decision (decision),
        INDEX idx_dt_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    log.info('Created table', { table: 'decision_traces' });

    log.info('Canonical data layer migration complete');
  } catch (err) {
    log.error('Canonical migration failed', err instanceof Error ? err : new Error(String(err)));
    process.exit(1);
  } finally {
    await conn.end();
  }
}

migrate();
