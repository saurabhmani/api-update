/**
 * Market Data Architecture Migration
 * Creates/updates the candles and market_data_snapshots tables.
 * Safe to re-run — uses CREATE TABLE IF NOT EXISTS.
 *
 * TWO USAGE MODES:
 *   1. Programmatic (from app code):
 *        import { migrateMarketData } from '@/lib/db/migrateMarketData';
 *        await migrateMarketData();
 *      Uses the shared db pool. Safe from Next.js API routes.
 *
 *   2. CLI (standalone):
 *        npx ts-node -P tsconfig.node.json -r tsconfig-paths/register src/lib/db/migrateMarketData.ts
 *      Loads .env.local from disk, creates its own connection, exits.
 */
import { db } from '../db';

const DDL_CANDLES = `
  CREATE TABLE IF NOT EXISTS candles (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    instrument_key VARCHAR(150) NOT NULL,
    candle_type    VARCHAR(15)  NOT NULL    COMMENT 'intraday | eod',
    interval_unit  VARCHAR(20)  NOT NULL    COMMENT '1minute | 5minute | 1day',
    ts             DATETIME     NOT NULL,
    open           DECIMAL(12,2) DEFAULT NULL,
    high           DECIMAL(12,2) DEFAULT NULL,
    low            DECIMAL(12,2) DEFAULT NULL,
    close          DECIMAL(12,2) DEFAULT NULL,
    volume         BIGINT        DEFAULT 0,
    oi             BIGINT        DEFAULT 0,
    UNIQUE KEY uq_candle (instrument_key, candle_type, interval_unit, ts),
    KEY idx_candles_key_ts (instrument_key, ts DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const DDL_SNAPSHOTS = `
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
    snapshot_ts    BIGINT        DEFAULT 0   COMMENT 'Unix ms',
    updated_at     DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_snapshot_symbol (symbol),
    KEY idx_snap_updated (updated_at DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/**
 * Programmatic entry — uses shared db pool.
 * Safe to call from Next.js API routes and auto-migration bootstrap.
 */
export async function migrateMarketData(): Promise<void> {
  await db.query(DDL_CANDLES);
  await db.query(DDL_SNAPSHOTS);
}

// ── CLI entry ─────────────────────────────────────────────────────
// Only executes when file is run directly (`tsx` / `ts-node`).
// Does NOT execute when imported by another module.
if (require.main === module) {
  (async () => {
    // Load .env.local manually (CLI mode — no Next.js env loader available)
    try {
      const fs = await import('fs');
      const path = await import('path');
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

    console.log('Running market data migration...\n');
    try {
      await migrateMarketData();
      console.log('✓ candles');
      console.log('✓ market_data_snapshots');
      console.log('\n✅ Market data migration complete.');
      process.exit(0);
    } catch (err) {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    }
  })();
}
