/**
 * NSE market-hours helper.
 *
 * Single source of truth for "is the market open right now?" used
 * by the freshness guard, the signals UI banner, the run-signal
 * engine route, and any other code that needs to adapt its
 * behavior to market state.
 *
 * NSE cash equity session (IST):
 *   Pre-open       09:00 – 09:15   (no trades, only order collection)
 *   Regular        09:15 – 15:30   ← what we treat as "open"
 *   Post-close     15:40 – 16:00   (not considered open here)
 *
 * Weekends are always closed. Public holidays would ideally also be
 * checked here but NSE publishes the list as a calendar PDF that
 * changes yearly — rather than shipping a stale holiday list, we
 * keep this file simple and rely on the freshness guard's tolerant
 * "allow yesterday's candle" rule to paper over holiday gaps.
 *
 * All math is done in IST regardless of server timezone so this
 * works correctly on AWS/Vercel boxes running UTC.
 */

export type MarketState = 'open' | 'closed' | 'pre-open' | 'holiday';

// NSE trading holidays — date strings in IST (YYYY-MM-DD). The
// ticker will still connect on these days but the UI should show
// "Holiday" instead of alarming on stale ticks.
//
// Extend via env var NSE_HOLIDAYS="2026-01-26,2026-04-14,..." to
// avoid a code deploy each year. Builtin list covers the dates
// currently known to the codebase; keep it minimal and data-driven.
const BUILTIN_NSE_HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. B.R. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-08-15', // Independence Day
  '2026-10-02', // Gandhi Jayanti
  '2026-12-25', // Christmas
];

function getHolidaySet(): Set<string> {
  const fromEnv = (process.env.NSE_HOLIDAYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  return new Set([...BUILTIN_NSE_HOLIDAYS_2026, ...fromEnv]);
}

function istDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export interface MarketStatus {
  /** True ONLY during the regular session (09:15–15:30 IST on a weekday). */
  isOpen:         boolean;
  /** Fine-grained state — lets callers distinguish "not started yet"
   *  from "closed for the day" if they care. */
  state:          MarketState;
  /** Human-readable label suitable for UI banners. */
  label:          string;
  /** ISO timestamp of the current IST wall clock (for diagnostics). */
  nowIst:         string;
  /** Today's session open in ISO (always present, even on weekends). */
  sessionOpenIst: string;
  /** Today's session close in ISO. */
  sessionCloseIst: string;
}

const OPEN_HOUR   = 9;
const OPEN_MINUTE = 15;
const CLOSE_HOUR  = 15;
const CLOSE_MINUTE = 30;

/**
 * Return a Date that, when interpreted via getUTC* accessors, reads
 * as the current IST wall clock. This is the standard trick for
 * doing timezone-agnostic math without a dependency like luxon.
 */
function nowInIst(): Date {
  return new Date(Date.now() + 5.5 * 3_600_000);
}

/** Build an IST wall-clock ISO string (no timezone suffix). */
function istIso(d: Date, h: number, m: number): string {
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const hh   = String(h).padStart(2, '0');
  const mi   = String(m).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:00+05:30`;
}

export function getMarketStatus(): MarketStatus {
  const ist      = nowInIst();
  const weekday  = ist.getUTCDay(); // 0 = Sun, 6 = Sat (interpreted in IST)
  const hour     = ist.getUTCHours();
  const minute   = ist.getUTCMinutes();
  const minutes  = hour * 60 + minute;
  const openMin  = OPEN_HOUR * 60 + OPEN_MINUTE;
  const closeMin = CLOSE_HOUR * 60 + CLOSE_MINUTE;

  const isWeekday = true; // 7-day mode: treat every day as a trading day
  void weekday;           // silence unused-variable warning
  const todayIst  = istDateString(ist);
  const holidays  = getHolidaySet();
  const isHoliday = holidays.has(todayIst);

  const sessionOpenIst  = istIso(ist, OPEN_HOUR, OPEN_MINUTE);
  const sessionCloseIst = istIso(ist, CLOSE_HOUR, CLOSE_MINUTE);

  // Expose the current IST wall clock as an ISO string
  const nowIst = istIso(ist, hour, minute).replace(':00+', `:${String(ist.getUTCSeconds()).padStart(2, '0')}+`);

  if (!isWeekday) {
    return {
      isOpen: false,
      state:  'closed',
      label:  'Market Closed (Weekend)',
      nowIst,
      sessionOpenIst,
      sessionCloseIst,
    };
  }

  if (isHoliday) {
    return {
      isOpen: false,
      state:  'holiday',
      label:  `Market Closed (NSE Holiday ${todayIst})`,
      nowIst,
      sessionOpenIst,
      sessionCloseIst,
    };
  }

  if (minutes < openMin) {
    return {
      isOpen: false,
      state:  'pre-open',
      label:  'Market Closed — Pre-open',
      nowIst,
      sessionOpenIst,
      sessionCloseIst,
    };
  }

  if (minutes >= closeMin) {
    return {
      isOpen: false,
      state:  'closed',
      label:  'Market Closed',
      nowIst,
      sessionOpenIst,
      sessionCloseIst,
    };
  }

  return {
    isOpen: true,
    state:  'open',
    label:  'Market Open',
    nowIst,
    sessionOpenIst,
    sessionCloseIst,
  };
}

/** Convenience wrapper — the common case. */
export function isMarketOpen(): boolean {
  return getMarketStatus().isOpen;
}
