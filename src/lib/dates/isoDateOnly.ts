import { toIstCalendarDate } from '@/lib/marketData/marketHours';

/**
 * Canonical YYYY-MM-DD for trading-session fields.
 * Never use `new Date(mysqlDate).toISOString()` — UTC shift corrupts DATE columns.
 */
export function parseIsoDateOnly(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return toIstCalendarDate(value);
  }
  return null;
}

/** Lexicographic compare for canonical date strings. */
export function compareIsoDateOnly(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a.localeCompare(b);
}
