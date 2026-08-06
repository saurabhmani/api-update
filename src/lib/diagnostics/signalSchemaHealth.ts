/**
 * Preflight schema health for q365_signals persistence.
 * A scan must not report success when required columns/indexes are missing.
 */
import { db } from '@/lib/db';

export const REQUIRED_SIGNAL_COLUMNS = [
  'composite_final_score',
  'classification',
  'batch_id',
  'created_at',
  'updated_at',
  'instrument_key',
  'generated_at',
  'status',
  'symbol',
  'direction',
  'final_score',
  'signal_status',
] as const;

export const REQUIRED_SIGNAL_INDEXES = [
  'idx_q365sig_classification',
] as const;

export interface SchemaHealthReport {
  ok: boolean;
  tableExists: boolean;
  missingColumns: string[];
  presentColumns: string[];
  missingIndexes: string[];
  presentIndexes: string[];
  error?: string;
}

export async function checkSignalSchemaHealth(): Promise<SchemaHealthReport> {
  try {
    const { rows: tables } = await db.query<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'`,
    );
    if (!tables.length) {
      return {
        ok: false,
        tableExists: false,
        missingColumns: [...REQUIRED_SIGNAL_COLUMNS],
        presentColumns: [],
        missingIndexes: [...REQUIRED_SIGNAL_INDEXES],
        presentIndexes: [],
        error: 'q365_signals table missing — run migrateSignalEngine',
      };
    }

    const { rows: cols } = await db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'`,
    );
    const presentColumns = cols.map((c) => c.COLUMN_NAME);
    const colSet = new Set(presentColumns.map((c) => c.toLowerCase()));
    const missingColumns = REQUIRED_SIGNAL_COLUMNS.filter(
      (c) => !colSet.has(c.toLowerCase()),
    );

    const { rows: idxs } = await db.query<{ INDEX_NAME: string }>(
      `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'`,
    );
    const presentIndexes = idxs.map((i) => i.INDEX_NAME);
    const idxSet = new Set(presentIndexes.map((i) => i.toLowerCase()));
    const missingIndexes = REQUIRED_SIGNAL_INDEXES.filter(
      (i) => !idxSet.has(i.toLowerCase()),
    );

    return {
      ok: missingColumns.length === 0,
      tableExists: true,
      missingColumns,
      presentColumns: REQUIRED_SIGNAL_COLUMNS.filter((c) => colSet.has(c.toLowerCase())),
      missingIndexes,
      presentIndexes: REQUIRED_SIGNAL_INDEXES.filter((i) => idxSet.has(i.toLowerCase())),
    };
  } catch (err) {
    return {
      ok: false,
      tableExists: false,
      missingColumns: [...REQUIRED_SIGNAL_COLUMNS],
      presentColumns: [],
      missingIndexes: [...REQUIRED_SIGNAL_INDEXES],
      presentIndexes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function assertSignalSchemaHealthy(report: SchemaHealthReport): void {
  if (report.ok) return;
  const parts: string[] = [];
  if (!report.tableExists) parts.push('table_missing');
  if (report.missingColumns.length) {
    parts.push(`missing_columns=${report.missingColumns.join(',')}`);
  }
  if (report.missingIndexes.length) {
    parts.push(`missing_indexes=${report.missingIndexes.join(',')} (non-fatal for write)`);
  }
  if (report.error) parts.push(`error=${report.error}`);
  // Indexes are advisory for preflight; missing columns are fatal.
  if (!report.tableExists || report.missingColumns.length > 0) {
    throw new Error(`SIGNAL_SCHEMA_UNHEALTHY: ${parts.join('; ')}`);
  }
}

export function logSchemaHealth(report: SchemaHealthReport): void {
  console.log(
    `[SCHEMA_HEALTH] table=q365_signals ok=${report.ok ? 1 : 0} ` +
    `missing_columns=${report.missingColumns.join(',') || 'none'} ` +
    `missing_indexes=${report.missingIndexes.join(',') || 'none'}` +
    (report.error ? ` error=${report.error}` : ''),
  );
}
