// ════════════════════════════════════════════════════════════════
//  Learning Engine — fallback persistence migration (MySQL)
//
//  Minimal `q365_signal_learning_observations` for health probes and
//  future writers. Idempotent — safe to re-run.
//
//  Full governance schema: migrations/postgres/011_*.sql.proposal
//  Replacement guide: migrations/mysql/012_*.sql header
// ════════════════════════════════════════════════════════════════

import { db } from '../db';

const TABLE = 'q365_signal_learning_observations';

const FALLBACK_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: 'signal_id',      ddl: 'BIGINT NULL' },
  { name: 'strategy_id',    ddl: 'VARCHAR(64) NULL' },
  { name: 'learning_tags',  ddl: 'JSON NULL' },
  { name: 'recommendation', ddl: 'VARCHAR(64) NULL' },
  { name: 'reviewed_at',    ddl: 'DATETIME NULL' },
];

const FALLBACK_INDEXES: Array<{ name: string; column: string }> = [
  { name: 'idx_signal',   column: 'signal_id' },
  { name: 'idx_strategy', column: 'strategy_id' },
];

/** Daily-report draft columns (011) that block minimal fallback INSERTs when NOT NULL. */
const LEGACY_RELAX_NULL = [
  'report_date',
  'observation_type',
  'observation',
  'governance_status',
  'priority',
] as const;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT       NULL,
    strategy_id     VARCHAR(64)  NULL,
    learning_tags   JSON         NULL,
    recommendation  VARCHAR(64)  NULL,
    reviewed_at     DATETIME     NULL,
    INDEX idx_signal   (signal_id),
    INDEX idx_strategy (strategy_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length === 0) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[LearningPersistence] Added column ${table}.${column}`);
  }
}

/** Recreate an index when it is missing or bound to a different column. */
async function ensureIndexOnColumn(table: string, indexName: string, column: string): Promise<void> {
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
     ORDER BY SEQ_IN_INDEX`,
    [table, indexName],
  );
  const bound = rows.map((r) => r.COLUMN_NAME);
  if (bound.length === 1 && bound[0] === column) return;

  if (bound.length > 0) {
    await db.query(`ALTER TABLE ${table} DROP INDEX ${indexName}`);
    console.log(`[LearningPersistence] Dropped misaligned index ${table}.${indexName} (was on ${bound.join(',')})`);
  }
  await db.query(`CREATE INDEX ${indexName} ON ${table} (${column})`);
  console.log(`[LearningPersistence] Ensured index ${table}.${indexName} (${column})`);
}

/** Allow fallback-only rows on tables that still carry the 011 draft columns. */
async function relaxLegacyNotNullColumns(table: string): Promise<void> {
  for (const column of LEGACY_RELAX_NULL) {
    const { rows } = await db.query<{ IS_NULLABLE: string; COLUMN_TYPE: string }>(
      `SELECT IS_NULLABLE, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    );
    if (rows.length === 0 || rows[0].IS_NULLABLE === 'YES') continue;
    await db.query(`ALTER TABLE ${table} MODIFY COLUMN \`${column}\` ${rows[0].COLUMN_TYPE} NULL`);
    console.log(`[LearningPersistence] Relaxed NOT NULL on legacy column ${table}.${column}`);
  }
}

export async function migrateLearningPersistence(): Promise<void> {
  console.log('[LearningPersistence] Applying fallback schema…');
  await db.query(CREATE_TABLE_SQL);

  for (const col of FALLBACK_COLUMNS) {
    await ensureColumn(TABLE, col.name, col.ddl);
  }
  await relaxLegacyNotNullColumns(TABLE);
  for (const idx of FALLBACK_INDEXES) {
    await ensureIndexOnColumn(TABLE, idx.name, idx.column);
  }

  console.log('[LearningPersistence] Fallback schema ready.');
}

export const LEARNING_PERSISTENCE_TABLE = TABLE;
export const LEARNING_PERSISTENCE_COLUMNS = FALLBACK_COLUMNS.map((c) => c.name);
export const LEARNING_PERSISTENCE_INDEXES = FALLBACK_INDEXES.map((i) => i.name);

if (require.main === module) {
  const path = require('path');
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({
      path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
    });
  }
  migrateLearningPersistence()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
