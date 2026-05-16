// ════════════════════════════════════════════════════════════════
//  IST time helpers — Asia/Kolkata formatting
//
//  Every trading-relevant timestamp in this codebase originates as
//  UTC milliseconds (tick ts, server wall clock, DB DATETIME). The
//  trader actually cares about IST, so the UI and structured logs
//  both need a consistent, dependency-free formatter.
//
//  All functions accept either an epoch-ms number, a Date, or null.
//  Null input → null output so callers can pass through absent
//  timestamps without a guard.
//
//  Why Intl.DateTimeFormat and not a date library?
//    - Node ships with full-ICU on modern runtimes
//    - Zero external dependency weight
//    - Handles DST edge cases that manual "+5:30" math doesn't
// ════════════════════════════════════════════════════════════════

const IST_TZ = 'Asia/Kolkata';

const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TZ,
  hour:   '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TZ,
  year:   'numeric',
  month:  '2-digit',
  day:    '2-digit',
  hour:   '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function toDate(input: number | Date | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input : null;
  if (typeof input === 'number' && Number.isFinite(input)) return new Date(input);
  return null;
}

/**
 * "09:45:08 IST" — time-of-day in Asia/Kolkata. Used for the live
 * ticker clock and the /api/kite/status `lastTickTimeIST` field. // @deprecated marker
 */
export function toIST(input: number | Date | null | undefined): string | null {
  const d = toDate(input);
  if (!d) return null;
  return `${TIME_FMT.format(d)} IST`;
}

/**
 * "2026-04-18 09:45:08 IST" — full calendar + wall-clock timestamp.
 * For log lines, audit columns, and tooltips where the bare time
 * of day would be ambiguous across sessions.
 */
export function toISTFull(input: number | Date | null | undefined): string | null {
  const d = toDate(input);
  if (!d) return null;
  // en-GB with the above options gives "18/04/2026, 09:45:08".
  // Swap to ISO-ish "YYYY-MM-DD HH:MM:SS" for grep-friendliness.
  const parts = DATETIME_FMT.formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
}

/**
 * Both UTC ISO and IST display form. Convenient for API responses
 * that want to stay backward-compatible with existing UTC readers
 * while offering humans an IST field to prefer.
 */
export function toPair(input: number | Date | null | undefined): {
  utc: string | null;
  ist: string | null;
} {
  const d = toDate(input);
  if (!d) return { utc: null, ist: null };
  return { utc: d.toISOString(), ist: toIST(d) };
}
