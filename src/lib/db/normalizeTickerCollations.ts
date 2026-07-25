/**
 * Align rankings + instruments to utf8mb4_unicode_ci so ticker/rankings
 * JOINs against q365_signals.instrument_key succeed.
 *
 * Root cause (errno 1267 ER_CANT_AGGREGATE_2COLLATIONS):
 *   rankings / instruments inherited MySQL 8+ server default
 *   utf8mb4_0900_ai_ci, while q365_* tables are utf8mb4_unicode_ci.
 *
 * Idempotent — safe on every ensureAllSchemas() boot.
 */

import { db } from '@/lib/db';

export const TICKER_CANONICAL_COLLATION = 'utf8mb4_unicode_ci';

/** Tables compared on textual identity keys in fetchFromMySQL / ticker. */
export const TICKER_COLLATION_TABLES = ['rankings', 'instruments'] as const;

export type TickerCollationTable = (typeof TICKER_COLLATION_TABLES)[number];

export async function normalizeTickerCollations(): Promise<{
  converted: string[];
  skipped: string[];
  databaseAligned: boolean;
}> {
  const converted: string[] = [];
  const skipped: string[] = [];
  let databaseAligned = false;

  try {
    const { rows: schemaRows } = await db.query<{
      DEFAULT_COLLATION_NAME: string;
    }>(
      `SELECT DEFAULT_COLLATION_NAME
         FROM information_schema.SCHEMATA
        WHERE SCHEMA_NAME = DATABASE()`,
    );
    const dbCollation = schemaRows[0]?.DEFAULT_COLLATION_NAME;
    if (dbCollation && dbCollation !== TICKER_CANONICAL_COLLATION) {
      await db.query(
        `ALTER DATABASE CHARACTER SET utf8mb4 COLLATE ${TICKER_CANONICAL_COLLATION}`,
      );
      databaseAligned = true;
      console.log(
        `[normalizeTickerCollations] database default → ${TICKER_CANONICAL_COLLATION}`,
      );
    }
  } catch (err: any) {
    console.warn(
      '[normalizeTickerCollations] ALTER DATABASE skipped:',
      err?.message ?? err,
    );
  }

  for (const table of TICKER_COLLATION_TABLES) {
    try {
      const { rows } = await db.query<{ TABLE_COLLATION: string | null }>(
        `SELECT TABLE_COLLATION
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?`,
        [table],
      );
      if (rows.length === 0) {
        skipped.push(`${table}:missing`);
        continue;
      }
      const current = rows[0]?.TABLE_COLLATION;
      if (current === TICKER_CANONICAL_COLLATION) {
        skipped.push(`${table}:already`);
        continue;
      }
      await db.query(
        `ALTER TABLE \`${table}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${TICKER_CANONICAL_COLLATION}`,
      );
      converted.push(table);
      console.log(
        `[normalizeTickerCollations] ${table}: ${current} → ${TICKER_CANONICAL_COLLATION}`,
      );
    } catch (err: any) {
      console.warn(
        `[normalizeTickerCollations] ${table} convert failed:`,
        err?.message ?? err,
      );
      skipped.push(`${table}:error`);
    }
  }

  // Enable the rankings↔q365_signals instrument_key join (ticker path).
  try {
    const { rows: idx } = await db.query<{ INDEX_NAME: string }>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'q365_signals'
          AND INDEX_NAME = 'idx_q365_signals_ikey_gen'
        LIMIT 1`,
    );
    if (idx.length === 0) {
      await db.query(
        `CREATE INDEX idx_q365_signals_ikey_gen
           ON q365_signals (instrument_key, generated_at)`,
      );
      console.log('[normalizeTickerCollations] added idx_q365_signals_ikey_gen');
    }
  } catch (err: any) {
    console.warn(
      '[normalizeTickerCollations] index ensure failed:',
      err?.message ?? err,
    );
  }

  console.log(
    `[normalizeTickerCollations] done converted=[${converted.join(',')}] ` +
      `skipped=[${skipped.join(',')}] databaseAligned=${databaseAligned}`,
  );

  return { converted, skipped, databaseAligned };
}
