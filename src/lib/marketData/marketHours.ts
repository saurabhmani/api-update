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

/**
 * Spec MARKET-AWARENESS — single union the dashboard / API layer uses
 * to label data freshness. Maps from the granular MarketState plus
 * a few extra "shape" buckets so the UI doesn't have to recombine
 * weekday + state on its own.
 */
export type MarketMode =
  | 'live'           // weekday, regular session 09:15–15:30 IST
  | 'pre_open'       // weekday, before 09:15
  | 'post_close'     // weekday, after 15:30
  | 'holiday'        // weekday on the NSE holiday list
  | 'weekend'        // Saturday / Sunday
  | 'market_closed'; // catch-all (unused on the happy path)

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

  // Saturday=6, Sunday=0 → market closed. Weekdays=1..5 → real session.
  // The "7-day mode" hardcode was a dev convenience that was bleeding
  // into production: weekend ticks were running rescore/regen and
  // burning IndianAPI quota on bars that don't move. Revert to the
  // honest calendar check; off-hours quota burn now stops automatically.
  const isWeekday = weekday >= 1 && weekday <= 5;
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

/**
 * Operator override — when FORCE_MARKET_OPEN=true (or 1) the signal
 * engine + signals API treat the market as open regardless of the
 * wall clock. Pipeline runs against the last available candles so
 * Phase 3/4 produces signals off-hours for testing / replay.
 *
 * MOCK_MARKET_OPEN and BYPASS_MARKET_HOURS are aliases kept for
 * back-compat with existing deployment configs.
 */
export function isMarketOverrideEnabled(): boolean {
  const norm = (v: string | undefined) => (v ?? '').trim().toLowerCase();
  return (
    norm(process.env.FORCE_MARKET_OPEN)   === 'true' ||
    norm(process.env.FORCE_MARKET_OPEN)   === '1'    ||
    norm(process.env.MOCK_MARKET_OPEN)    === 'true' ||
    norm(process.env.MOCK_MARKET_OPEN)    === '1'    ||
    norm(process.env.BYPASS_MARKET_HOURS) === 'true' ||
    norm(process.env.BYPASS_MARKET_HOURS) === '1'
  );
}

// ── Spec MARKET-AWARENESS — API envelope ─────────────────────────

/**
 * Mode union derivation. `getMarketStatus().state` is granular
 * ('open' | 'closed' | 'pre-open' | 'holiday') but doesn't
 * distinguish weekend from weekday-after-close. The API envelope
 * needs that distinction so the dashboard can show "Weekend — Last
 * Close Data" vs "Post-close — Last Close Data".
 */
function deriveMode(s: MarketStatus): MarketMode {
  if (s.isOpen) return 'live';
  if (s.state === 'pre-open') return 'pre_open';
  if (s.state === 'holiday')  return 'holiday';
  // 'closed' — split weekend vs post-close based on the IST weekday.
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  const wd  = ist.getUTCDay();
  if (wd === 0 || wd === 6) return 'weekend';
  return 'post_close';
}

export interface MarketEnvelope {
  /** Spec-aligned union the dashboard reads. */
  mode:             MarketMode;
  isOpen:           boolean;
  state:            MarketState;
  /** Human-readable label suitable for UI banners. */
  label:            string;
  nowIst:           string;
  sessionOpenIst:   string;
  sessionCloseIst:  string;
  isHoliday:        boolean;
  /** One-line reason explaining the current label (weekend / holiday name / pre-open / post-close). */
  reason:           string | null;
  /**
   * True when an env var bypasses the real market clock. Useful
   * defensive flag for the UI: even if the runtime forces a state,
   * operators can see it in the response.
   */
  bypassActive:     boolean;
  bypassReason:     string | null;
}

/** Detect operator bypass envs that would force the market status
 *  away from the wall-clock truth. We surface this in the envelope
 *  so the dashboard can warn loudly if it sees a non-real-time mode. */
function detectBypass(): { active: boolean; reason: string | null } {
  // Q365_REGEN_24X7 was historically used to allow off-hours regen
  // jobs; some old configs left it on which silently enabled live
  // paths. We only TREAT bypass as active when an explicit bypass
  // flag is set — never the regen flag.
  if (process.env.FORCE_MARKET_OPEN === '1' ||
      process.env.FORCE_MARKET_OPEN?.toLowerCase() === 'true') {
    return { active: true, reason: 'FORCE_MARKET_OPEN env is set' };
  }
  if (process.env.MOCK_MARKET_OPEN === '1' ||
      process.env.MOCK_MARKET_OPEN?.toLowerCase() === 'true') {
    return { active: true, reason: 'MOCK_MARKET_OPEN env is set' };
  }
  if (process.env.BYPASS_MARKET_HOURS === '1' ||
      process.env.BYPASS_MARKET_HOURS?.toLowerCase() === 'true') {
    return { active: true, reason: 'BYPASS_MARKET_HOURS env is set' };
  }
  return { active: false, reason: null };
}

/**
 * Build the API envelope returned by `/api/market-status` and
 * embedded in `/api/ticker`, `/api/rankings`, `/api/signals`. This
 * is the single source of truth — no other module should infer the
 * mode independently.
 */
export function getMarketEnvelope(): MarketEnvelope {
  const status = getMarketStatus();
  const bypass = detectBypass();

  // Spec §7 — bypass envs DO NOT flip mode. The dashboard's UI
  // contract is "show LIVE only when the wall clock says open"; an
  // env-forced override would lie about freshness. We surface the
  // bypass flag in the envelope so a debug panel can warn, but mode
  // remains derived from the calendar.
  const mode = deriveMode(status);

  let reason: string | null = null;
  if (mode === 'weekend')      reason = 'Saturday / Sunday — markets closed';
  else if (mode === 'holiday') reason = status.label;
  else if (mode === 'pre_open') reason = 'Before regular session (09:15 IST)';
  else if (mode === 'post_close') reason = 'After regular session (15:30 IST)';

  return {
    mode,
    isOpen:          status.isOpen,
    state:           status.state,
    label:           status.label,
    nowIst:          status.nowIst,
    sessionOpenIst:  status.sessionOpenIst,
    sessionCloseIst: status.sessionCloseIst,
    isHoliday:       status.state === 'holiday',
    reason,
    bypassActive:    bypass.active,
    bypassReason:    bypass.reason,
  };
}
