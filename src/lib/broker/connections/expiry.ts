/**
 * Parse Shoonya / broker token expiry fields.
 *
 * `expires_in` is ambiguous across brokers:
 * - duration seconds (e.g. 86400) when value is relatively small
 * - Unix epoch seconds when value looks like a timestamp (>= 1e9)
 * - Unix epoch milliseconds when value is >= 1e12
 *
 * ISO date strings are also accepted.
 * Always returns a UTC Date, or null when unparseable.
 */
export function parseBrokerTokenExpiry(
  value: unknown,
  nowMs: number = Date.now(),
): Date | null {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return fromNumericExpiry(value, nowMs);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return fromNumericExpiry(Number(trimmed), nowMs);
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function fromNumericExpiry(n: number, nowMs: number): Date | null {
  if (!Number.isFinite(n) || n <= 0) return null;

  // Epoch milliseconds
  if (n >= 1e12) {
    return new Date(n);
  }

  // Epoch seconds (year ~2001+)
  if (n >= 1e9) {
    return new Date(n * 1000);
  }

  // Treat as duration in seconds from now (cap at 30 days to avoid absurd values)
  if (n <= 30 * 24 * 60 * 60) {
    return new Date(nowMs + n * 1000);
  }

  // Large but not epoch — treat as duration seconds anyway with clamp
  return new Date(nowMs + Math.min(n, 30 * 24 * 60 * 60) * 1000);
}

/** Format a Date as MySQL UTC DATETIME string (YYYY-MM-DD HH:MM:SS). */
export function toMysqlUtcDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
