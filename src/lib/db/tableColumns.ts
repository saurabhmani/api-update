import { db } from '@/lib/db';

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { loadedAt: number; columns: Set<string> }>();

export async function getTableColumns(table: string): Promise<Set<string>> {
  if (!/^[a-zA-Z0-9_]+$/.test(table)) {
    throw new TypeError('Invalid table name');
  }
  const now = Date.now();
  const current = cache.get(table);
  if (current && now - current.loadedAt < CACHE_TTL_MS) return current.columns;

  const { rows } = await db.query<{ Field: string }>(`SHOW COLUMNS FROM \`${table}\``);
  const columns = new Set(rows.map((row) => String(row.Field)));
  cache.set(table, { loadedAt: now, columns });
  return columns;
}

export function optionalColumnExpression(
  columns: Set<string>,
  alias: string,
  column: string,
  outputAlias: string,
): string {
  if (!/^[a-zA-Z0-9_]+$/.test(alias)
    || !/^[a-zA-Z0-9_]+$/.test(column)
    || !/^[a-zA-Z0-9_]+$/.test(outputAlias)) {
    throw new TypeError('Invalid SQL identifier');
  }
  return columns.has(column)
    ? `${alias}.\`${column}\` AS \`${outputAlias}\``
    : `NULL AS \`${outputAlias}\``;
}
