// ════════════════════════════════════════════════════════════════
//  Public Signal Ledger — MySQL migration (032)
//
//  Idempotent schema ensure for q365_signal_outcomes public-ledger
//  columns. Safe on legacy installs (Phase 4 / closure shapes).
//  Never modifies q365_signals.
// ════════════════════════════════════════════════════════════════

import { db } from '../db';

export const SIGNAL_OUTCOMES_TABLE = 'q365_signal_outcomes';

const PUBLIC_LEDGER_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'signal_id',          ddl: 'BIGINT NULL' },
  { name: 'strategy_id',        ddl: 'VARCHAR(64) NULL' },
  { name: 'symbol',             ddl: 'VARCHAR(64) NULL' },
  { name: 'outcome',            ddl: 'VARCHAR(24) NULL' },
  { name: 'outcome_at',         ddl: 'DATETIME NULL' },
  { name: 'days_held',          ddl: 'INT NOT NULL DEFAULT 0' },
  { name: 'max_gain_pct',       ddl: 'DECIMAL(10,4) NULL' },
  { name: 'candle_check_count', ddl: 'INT NOT NULL DEFAULT 0' },
  { name: 'resolved_at',        ddl: 'DATETIME NULL DEFAULT CURRENT_TIMESTAMP' },
];

const PUBLIC_LEDGER_INDEXES: Array<{ name: string; columns: string }> = [
  { name: 'idx_q365_signal_outcomes_strategy_outcome', columns: 'strategy_id, outcome' },
  { name: 'idx_q365_signal_outcomes_outcome_at',       columns: 'outcome_at' },
];

const UNIQUE_SIGNAL = 'uq_q365_signal_outcomes_signal';

const PUBLIC_SIGNALS_FEED_INDEX = 'idx_q365_signals_public_feed';

const CREATE_GREENFIELD_SQL = `
  CREATE TABLE IF NOT EXISTS ${SIGNAL_OUTCOMES_TABLE} (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id           BIGINT       NOT NULL,
    strategy_id         VARCHAR(64)  NOT NULL,
    symbol              VARCHAR(64)  NOT NULL,
    outcome             VARCHAR(24)  NOT NULL,
    outcome_at          DATETIME     NOT NULL,
    days_held           INT          NOT NULL DEFAULT 0,
    max_gain_pct        DECIMAL(10,4) DEFAULT NULL,
    candle_check_count  INT          NOT NULL DEFAULT 0,
    resolved_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY ${UNIQUE_SIGNAL} (signal_id),
    INDEX idx_q365_signal_outcomes_strategy_outcome (strategy_id, outcome),
    INDEX idx_q365_signal_outcomes_outcome_at (outcome_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await db.query<{ t: string }>(
    `SHOW TABLES LIKE ?`,
    [table],
  );
  return rows.length > 0;
}

async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length === 0) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[SignalOutcomesPublic] Added column ${table}.${column}`);
  }
}

async function indexExists(table: string, indexName: string): Promise<boolean> {
  const { rows } = await db.query<{ INDEX_NAME: string }>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
     LIMIT 1`,
    [table, indexName],
  );
  return rows.length > 0;
}

async function ensureIndex(table: string, indexName: string, columns: string): Promise<void> {
  if (await indexExists(table, indexName)) return;
  await db.query(`CREATE INDEX ${indexName} ON ${table} (${columns})`);
  console.log(`[SignalOutcomesPublic] Created index ${table}.${indexName}`);
}

async function ensureUniqueSignalIndex(table: string): Promise<void> {
  if (await indexExists(table, UNIQUE_SIGNAL)) return;

  const { rows } = await db.query<{ INDEX_NAME: string }>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND NON_UNIQUE = 0 AND COLUMN_NAME = 'signal_id'
     LIMIT 1`,
    [table],
  );
  if (rows.length > 0) {
    console.log(`[SignalOutcomesPublic] Unique on signal_id already present (${rows[0].INDEX_NAME})`);
    return;
  }

  await db.query(`CREATE UNIQUE INDEX ${UNIQUE_SIGNAL} ON ${table} (signal_id)`);
  console.log(`[SignalOutcomesPublic] Created unique index ${table}.${UNIQUE_SIGNAL}`);
}

async function ensureForeignKey(table: string): Promise<void> {
  const { rows } = await db.query<{ CONSTRAINT_NAME: string }>(
    `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'
       AND CONSTRAINT_NAME = 'fk_q365_signal_outcomes_signal'`,
    [table],
  );
  if (rows.length > 0) return;

  try {
    await db.query(
      `ALTER TABLE ${table}
       ADD CONSTRAINT fk_q365_signal_outcomes_signal
       FOREIGN KEY (signal_id) REFERENCES q365_signals (id) ON DELETE CASCADE`,
    );
    console.log(`[SignalOutcomesPublic] Added FK ${table}.signal_id → q365_signals.id`);
  } catch (err) {
    console.warn(
      `[SignalOutcomesPublic] FK skipped (orphan rows or engine limitation):`,
      (err as Error).message,
    );
  }
}

export async function migrateSignalOutcomesPublic(): Promise<void> {
  console.log('[SignalOutcomesPublic] Applying public ledger schema…');

  const existed = await tableExists(SIGNAL_OUTCOMES_TABLE);
  await db.query(CREATE_GREENFIELD_SQL);

  if (existed) {
    for (const col of PUBLIC_LEDGER_COLUMNS) {
      await ensureColumn(SIGNAL_OUTCOMES_TABLE, col.name, col.ddl);
    }
  }

  await ensureUniqueSignalIndex(SIGNAL_OUTCOMES_TABLE);
  for (const idx of PUBLIC_LEDGER_INDEXES) {
    await ensureIndex(SIGNAL_OUTCOMES_TABLE, idx.name, idx.columns);
  }
  await ensureForeignKey(SIGNAL_OUTCOMES_TABLE);
  await ensureIndex('q365_signals', PUBLIC_SIGNALS_FEED_INDEX, 'signal_status, created_at');

  console.log('[SignalOutcomesPublic] Schema ready.');
}

export const SIGNAL_OUTCOMES_PUBLIC_COLUMNS = PUBLIC_LEDGER_COLUMNS.map((c) => c.name);
export const SIGNAL_OUTCOMES_PUBLIC_INDEXES = [
  UNIQUE_SIGNAL,
  ...PUBLIC_LEDGER_INDEXES.map((i) => i.name),
];

if (require.main === module) {
  const path = require('path');
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({
      path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
    });
  }
  migrateSignalOutcomesPublic()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
