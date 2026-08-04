import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { resetFullAndMigrate } from '../../scripts/backtestIntegrationDb';

const enabled = process.env.BACKTEST_MYSQL_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;
const config = {
  host: process.env.BACKTEST_IT_DB_HOST ?? '127.0.0.1', port: Number(process.env.BACKTEST_IT_DB_PORT ?? 33316),
  user: process.env.BACKTEST_IT_DB_USER ?? 'backtest_it', password: process.env.BACKTEST_IT_DB_PASSWORD ?? 'integration-only',
  database: process.env.BACKTEST_IT_DB_NAME ?? 'quantorus_backtest_it',
};

suite('Backtest full disposable schema', () => {
  it('applies through migration 017 and bulk-loads fixture v2', async () => {
    process.env.MYSQL_HOST = config.host; process.env.MYSQL_PORT = String(config.port); process.env.MYSQL_USER = config.user;
    process.env.MYSQL_PASSWORD = config.password; process.env.MYSQL_DATABASE = config.database;
    await resetFullAndMigrate();
    const connection = await mysql.createConnection(config);
    try {
      const [migrations]: any = await connection.query(`SELECT version FROM backtest_schema_migrations ORDER BY version`);
      const [authority]: any = await connection.query(`SELECT owner,epoch FROM backtest_processor_ownership WHERE singleton_id=1`);
      const [candles]: any = await connection.query(`SELECT instrument_key,COUNT(*) count FROM candles GROUP BY instrument_key ORDER BY instrument_key`);
      const [columns]: any = await connection.query(`SHOW COLUMNS FROM backtest_runs LIKE 'ownership_epoch'`);
      expect(migrations.map((row: any) => row.version)).toEqual(['016', '017']);
      expect(authority).toEqual([expect.objectContaining({ owner: 'monolith', epoch: 1 })]);
      expect(candles.map((row: any) => [row.instrument_key, Number(row.count)])).toEqual([
        ['FIXTURE-A', 280], ['FIXTURE-B', 280], ['FIXTURE-BENCH', 280],
      ]);
      expect(columns).toHaveLength(1);
    } finally { await connection.end(); }
  }, 120_000);
});
