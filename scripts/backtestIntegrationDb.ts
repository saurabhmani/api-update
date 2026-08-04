import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const config = { host: process.env.BACKTEST_IT_DB_HOST ?? '127.0.0.1', port: Number(process.env.BACKTEST_IT_DB_PORT ?? 33316), user: process.env.BACKTEST_IT_DB_USER ?? 'backtest_it', password: process.env.BACKTEST_IT_DB_PASSWORD ?? 'integration-only', database: process.env.BACKTEST_IT_DB_NAME ?? 'quantorus_backtest_it', multipleStatements: true };
const migrations = ['migrations/mysql/016_backtest_queue_leases.sql','migrations/mysql/017_backtest_processor_ownership.sql'];
const legacyTable = `CREATE TABLE backtest_runs (
 run_id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, config_json JSON NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'queued', started_at DATETIME NOT NULL, completed_at DATETIME NULL,
 duration_ms INT NULL, error TEXT NULL, summary_json JSON NULL, strategy_breakdown_json JSON NULL,
 regime_breakdown_json JSON NULL, signal_count INT DEFAULT 0, trade_count INT DEFAULT 0, created_by VARCHAR(100) NULL,
 progress_percent INT DEFAULT 0, current_step VARCHAR(255) NULL,
 created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX idx_br_status(status), INDEX idx_br_started(started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export async function resetAndMigrate() {
  const connection = await mysql.createConnection(config);
  try {
    for (const table of ['backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','backtest_equity_curve','backtest_audit_logs','calibration_snapshots','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary']) {
      await connection.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await connection.query('DROP TABLE IF EXISTS backtest_runs');
    await connection.query('DROP TABLE IF EXISTS backtest_processor_ownership');
    await connection.query('DROP TABLE IF EXISTS backtest_schema_migrations');
    await connection.query(legacyTable);
    for (const table of ['backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','backtest_equity_curve','backtest_audit_logs','calibration_snapshots','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary']) {
      await connection.query(`CREATE TABLE IF NOT EXISTS ${table} (id BIGINT AUTO_INCREMENT PRIMARY KEY, run_id VARCHAR(36) NOT NULL, payload VARCHAR(32) NULL, INDEX(run_id)) ENGINE=InnoDB`);
      await connection.query(`DELETE FROM ${table}`);
    }
    await connection.query(`CREATE TABLE backtest_schema_migrations (version VARCHAR(32) PRIMARY KEY, filename VARCHAR(255) NOT NULL, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL)`);
    for (const migration of migrations) {
      const sql = await fs.readFile(migration, 'utf8'); const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      await connection.query(sql); const version = migration.match(/\/(\d+)_/)?.[1] ?? migration;
      await connection.query(`INSERT INTO backtest_schema_migrations VALUES (?, ?, ?, NOW(3))`, [version, migration, checksum]);
    }
  } finally { await connection.end(); }
}

/** Full disposable schema for real-runner evidence. Never targets production. */
export async function resetFullAndMigrate() {
  const phase = (name: string, startedAt = Date.now()) => {
    console.log(JSON.stringify({ event: 'backtest_integration_schema_phase', phase: name, elapsedMs: Date.now() - startedAt }));
    return Date.now();
  };
  let phaseStarted = phase('drop-start');
  const connection = await mysql.createConnection(config);
  try {
    for (const table of ['backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','backtest_equity_curve','backtest_audit_logs','calibration_snapshots','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary','strategy_backtests','backtest_runs','backtest_processor_ownership','backtest_schema_migrations','candles']) {
      await connection.query(`DROP TABLE IF EXISTS ${table}`);
    }
  } finally { await connection.end(); }
  phaseStarted = phase('drop-complete', phaseStarted);
  process.env.MYSQL_HOST = config.host; process.env.MYSQL_PORT = String(config.port); process.env.MYSQL_USER = config.user;
  process.env.MYSQL_PASSWORD = config.password; process.env.MYSQL_DATABASE = config.database;
  const [{ migrateBacktestTables }, { closeDbPool }] = await Promise.all([
    import('../src/lib/backtesting/repository/migrate'), import('../src/lib/db'),
  ]);
  try { await migrateBacktestTables({ includeQueueLeaseColumns: false }); }
  finally { await closeDbPool(); }
  phaseStarted = phase('base-schema-complete', phaseStarted);
  const migrated = await mysql.createConnection(config);
  try {
    await migrated.query(`CREATE TABLE candles (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, instrument_key VARCHAR(128) NOT NULL, candle_type VARCHAR(16) NOT NULL,
      interval_unit VARCHAR(16) NOT NULL, ts DATETIME(3) NOT NULL, open DECIMAL(18,6) NOT NULL, high DECIMAL(18,6) NOT NULL,
      low DECIMAL(18,6) NOT NULL, close DECIMAL(18,6) NOT NULL, volume BIGINT NOT NULL,
      UNIQUE KEY uq_fixture_candle(instrument_key,candle_type,interval_unit,ts), INDEX idx_fixture_candle_lookup(instrument_key,candle_type,interval_unit,ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await migrated.query(`CREATE TABLE backtest_schema_migrations (version VARCHAR(32) PRIMARY KEY, filename VARCHAR(255) NOT NULL, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL)`);
    for (const migration of migrations) {
      const sql = await fs.readFile(migration, 'utf8'); const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      await migrated.query(sql); const version = migration.match(/\/(\d+)_/)?.[1] ?? migration;
      await migrated.query(`INSERT INTO backtest_schema_migrations VALUES (?, ?, ?, NOW(3))`, [version, migration, checksum]);
    }
    phaseStarted = phase('migrations-complete', phaseStarted);
    const candles = JSON.parse(await fs.readFile('src/test-fixtures/backtesting/candles.json', 'utf8'));
    const chunkSize = 200;
    for (let offset = 0; offset < candles.length; offset += chunkSize) {
      const chunk = candles.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => "(?,'eod','1day',?,?,?,?,?,?)").join(',');
      const values = chunk.flatMap((candle: any) => [candle.symbol, String(candle.timestamp).replace('T', ' ').replace('Z', ''), candle.open, candle.high, candle.low, candle.close, candle.volume]);
      await migrated.query(`INSERT INTO candles(instrument_key,candle_type,interval_unit,ts,open,high,low,close,volume) VALUES ${placeholders}`, values);
    }
    phase('fixture-load-complete', phaseStarted);
  } finally { await migrated.end(); }
}
async function inspect() {
  const connection = await mysql.createConnection(config);
  try {
    const [version] = await connection.query('SELECT VERSION() version');
    const [migrationRows] = await connection.query('SELECT * FROM backtest_schema_migrations ORDER BY version');
    const [statuses] = await connection.query('SELECT status, COUNT(*) count FROM backtest_runs GROUP BY status');
    console.log(JSON.stringify({ database: config.database, version, migrations: migrationRows, statuses }, null, 2));
  } finally { await connection.end(); }
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/scripts/backtestIntegrationDb.ts')) {
  const command = process.argv[2] ?? 'inspect';
  if (command === 'reset-full') resetFullAndMigrate().then(inspect).catch(error => { console.error(error); process.exitCode = 1; });
  else if (command === 'reset' || command === 'migrate') resetAndMigrate().then(inspect).catch(error => { console.error(error); process.exitCode = 1; });
  else inspect().catch(error => { console.error(error); process.exitCode = 1; });
}
