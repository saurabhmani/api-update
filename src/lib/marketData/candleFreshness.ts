// ════════════════════════════════════════════════════════════════
//  Candle Freshness Gate — Spec CANDLE-FRESHNESS-2026-05.
//
//  Single source of truth for "is the candle layer alive enough to
//  trust?". Categorises the latest candle timestamp into a quality
//  band, emits [CANDLE_FRESHNESS] / [CANDLE_SOURCE] / [FRESHNESS_MODE]
//  / [STALE_CANDLE_REJECT] / [FROZEN_FEED_DETECTED] telemetry, and
//  produces a typed report the elite gate consults before approving
//  rows.
//
//  Quality bands (during market hours, INTRADAY/LIVE_TICK source):
//    fresh    — candle_age <= 5 min
//    aging    — candle_age <= 30 min
//    stale    — candle_age <= 4 h
//    frozen   — candle_age >  4 h  (refuse to ship elite rows)
//
//  Daily-tolerant bands (DAILY/FALLBACK_DAILY/CACHED_DAILY):
//    Off-hours / closed market:
//      fresh    — <=  6 h
//      aging    — <= 24 h
//      stale    — <= 72 h
//      frozen   — >  72 h
//    Market open (session-aware — prior-session EOD bar is still the
//    live warehouse row until today's bar lands, so midday can be
//    24–30h old without the feed being broken):
//      fresh    — <=  6 h
//      aging    — <= 48 h
//      stale    — <= 72 h
//      frozen   — >  72 h
//
//  Source-blind classification used to fire `feed_frozen=true` for
//  every market-hours poll on daily-only deployments, blocking the
//  elite gate from ever shipping. The source axis fixes that.
//
//  Pure module — no I/O. The probe (DB lookup of latest candle ts)
//  lives outside; this module categorises a known timestamp.
// ════════════════════════════════════════════════════════════════

export type CandleFreshnessQuality = 'fresh' | 'aging' | 'stale' | 'frozen' | 'unknown';

/** Candle source axis. Drives whether intraday-strict (5min/30min/4h)
 *  or daily-tolerant (6h/24h/72h) thresholds apply. `null`/undefined
 *  falls back to `CANDLE_FEED_SOURCE` env, then to the legacy
 *  market-open-driven behaviour. */
export type CandleSource =
  | 'live_tick'
  | 'intraday'
  | 'daily'
  | 'fallback_daily'
  | 'cached_daily'
  | 'unknown';

/** True when the source produces a single bar per session — daily
 *  candles age 18+h between updates and must not be frozen-checked
 *  with intraday thresholds. */
function isDailyClassSource(source: CandleSource | null | undefined): boolean {
  return source === 'daily'
      || source === 'fallback_daily'
      || source === 'cached_daily';
}

/** Resolve effective source: explicit param wins, then env, then
 *  'unknown'. Trim/lowercase normalises operator-set env values. */
function resolveCandleSource(source: CandleSource | null | undefined): CandleSource {
  if (source) return source;
  const env = (process.env.CANDLE_FEED_SOURCE ?? '').trim().toLowerCase();
  if (env === 'live_tick' || env === 'intraday' || env === 'daily'
      || env === 'fallback_daily' || env === 'cached_daily') {
    return env as CandleSource;
  }
  return 'unknown';
}

export type FreshnessMode = 'intraday_strict' | 'daily_tolerant';

export interface CandleFreshnessReport {
  /** Epoch ms of the most-recent candle. null = no candles found. */
  latest_candle_ms:   number | null;
  /** Wall-clock now used for the age computation. */
  computed_at_ms:     number;
  /** Age in seconds; null when latest_candle_ms is null. */
  candle_age_seconds: number | null;
  /** Categorical quality. 'unknown' when latest_candle_ms is null. */
  freshness_quality:  CandleFreshnessQuality;
  /** True when the elite gate should hard-refuse to ship rows because
   *  the candle layer hasn't updated in a market-meaningful window.
   *  i.e. quality === 'frozen'. */
  feed_frozen:        boolean;
  /** Market-hours flag at probe time (drives the band thresholds). */
  market_open:        boolean;
  /** Resolved candle source (explicit param → CANDLE_FEED_SOURCE env
   *  → 'unknown'). */
  candle_source:      CandleSource;
  /** Which threshold table was applied:
   *    intraday_strict  → 5 min / 30 min / 4 h
   *    daily_tolerant   → 6 h / 24 h / 72 h
   *  Daily-class sources always force `daily_tolerant` regardless of
   *  market_open — that's the fix for the daily-feed false-positive. */
  freshness_mode:     FreshnessMode;
}

const OPEN_FRESH_S    = 5    * 60;
const OPEN_AGING_S    = 30   * 60;
const OPEN_STALE_S    = 4    * 60 * 60;
const CLOSED_FRESH_S       = 6    * 60 * 60;
const CLOSED_AGING_S       = 24   * 60 * 60;
const CLOSED_STALE_S       = 72   * 60 * 60;
/** Prior-session daily bar during the cash session — widened so a
 *  27h-old warehouse row at noon is "aging", not "stale". */
const OPEN_DAILY_AGING_S   = 48   * 60 * 60;

/** Pure categorisation. Given a latest candle timestamp, market state,
 *  and candle source, return the quality band.
 *
 *  `candle_source` is optional for back-compat with callers that pre-
 *  date the source axis (e.g. test fixtures, health/metrics probes
 *  that don't know the source). When omitted, `CANDLE_FEED_SOURCE`
 *  env is consulted; setting `CANDLE_FEED_SOURCE=daily` on a daily-
 *  only deployment is sufficient to fix the false-positive
 *  market-hours frozen-feed.
 *
 *  Daily-class sources (`daily` / `fallback_daily` / `cached_daily`)
 *  use daily_tolerant bands. During market hours the aging ceiling is
 *  widened to 48h so the prior session's EOD row is not mis-labelled
 *  stale at midday. Off-hours keeps the tighter 24h aging band. */
export function classifyCandleFreshness(opts: {
  latest_candle_ms: number | null;
  now_ms?:          number;
  market_open:      boolean;
  candle_source?:   CandleSource | null;
}): CandleFreshnessReport {
  const now           = opts.now_ms ?? Date.now();
  const source        = resolveCandleSource(opts.candle_source);
  const dailyClass    = isDailyClassSource(source);
  // Daily-class sources force daily_tolerant. Intraday/live_tick/unknown
  // follow the legacy market-open-driven split so existing tests and
  // probes that call without a source argument keep their behaviour.
  const useTolerant   = dailyClass ? true : !opts.market_open;
  const freshnessMode: FreshnessMode = useTolerant ? 'daily_tolerant' : 'intraday_strict';

  if (opts.latest_candle_ms == null || !Number.isFinite(opts.latest_candle_ms)) {
    return {
      latest_candle_ms:   null,
      computed_at_ms:     now,
      candle_age_seconds: null,
      freshness_quality:  'unknown',
      feed_frozen:        false,
      market_open:        opts.market_open,
      candle_source:      source,
      freshness_mode:     freshnessMode,
    };
  }
  const ageS = Math.max(0, Math.round((now - opts.latest_candle_ms) / 1000));
  const tolerantAgingS =
    dailyClass && opts.market_open ? OPEN_DAILY_AGING_S : CLOSED_AGING_S;
  let quality: CandleFreshnessQuality;
  if (useTolerant) {
    if (ageS <= CLOSED_FRESH_S)        quality = 'fresh';
    else if (ageS <= tolerantAgingS)  quality = 'aging';
    else if (ageS <= CLOSED_STALE_S)  quality = 'stale';
    else                               quality = 'frozen';
  } else {
    if (ageS <= OPEN_FRESH_S)      quality = 'fresh';
    else if (ageS <= OPEN_AGING_S) quality = 'aging';
    else if (ageS <= OPEN_STALE_S) quality = 'stale';
    else                            quality = 'frozen';
  }
  return {
    latest_candle_ms:   opts.latest_candle_ms,
    computed_at_ms:     now,
    candle_age_seconds: ageS,
    freshness_quality:  quality,
    feed_frozen:        quality === 'frozen',
    market_open:        opts.market_open,
    candle_source:      source,
    freshness_mode:     freshnessMode,
  };
}

/** Whether `market_data_daily` is fresh enough to permit maturity-tracker
 *  promotion into confirmed snapshots.
 *
 *  Uses `daily_tolerant` bands (6h / 24h / 72h) regardless of market
 *  hours. Daily bars are stamped once per session — by midday they are
 *  naturally 6–8h old and must NOT trip the legacy open-market 360min
 *  wall-clock cap that previously blocked every promotion until after
 *  15:30 IST when the closed-market 48h cap kicked in.
 *
 *  Only `feed_frozen` (>72h for daily) blocks promotion. */
export function isDailyCandleWarehousePromotable(
  latestCandleMs: number | null,
  opts: { marketOpen?: boolean; nowMs?: number } = {},
): { ok: boolean; report: CandleFreshnessReport } {
  const report = classifyCandleFreshness({
    latest_candle_ms: latestCandleMs,
    market_open:      opts.marketOpen ?? true,
    now_ms:           opts.nowMs,
    candle_source:    'daily',
  });
  return { ok: !report.feed_frozen, report };
}

/** Emit [CANDLE_FRESHNESS] + [CANDLE_SOURCE] + [FRESHNESS_MODE]
 *  + side-channel logs based on the report.
 *  - Always emits [CANDLE_FRESHNESS] (one line per check) with the
 *    resolved source and the threshold table that was applied.
 *  - Always emits [CANDLE_SOURCE] (operator-friendly one-liner) so
 *    daily-only deployments are easy to spot in logs.
 *  - Always emits [FRESHNESS_MODE] showing intraday_strict vs.
 *    daily_tolerant — answers "why is this candle considered fresh
 *    when it's 18h old".
 *  - Emits [STALE_CANDLE_REJECT] when quality is 'stale' (but not
 *    frozen — stale rows can still inform; freshness banner warns).
 *  - Emits [FROZEN_FEED_DETECTED] when feed_frozen — operator must
 *    treat the elite output as suspect / blank. The [FREEZE_REASON]
 *    sub-line distinguishes "intraday feed actually died" from
 *    "daily candle older than 72h" so operators don't chase ghosts. */
export function logCandleFreshness(
  report: CandleFreshnessReport,
  context: string,
): void {
  console.log('[CANDLE_FRESHNESS]', {
    context,
    candle_age_seconds: report.candle_age_seconds,
    freshness_quality:  report.freshness_quality,
    market_open:        report.market_open,
    candle_source:      report.candle_source,
    freshness_mode:     report.freshness_mode,
    latest_candle_iso:  report.latest_candle_ms != null
      ? new Date(report.latest_candle_ms).toISOString() : null,
  });
  console.log('[CANDLE_SOURCE]', { context, candle_source: report.candle_source });
  console.log('[FRESHNESS_MODE]', {
    context,
    freshness_mode: report.freshness_mode,
    market_open:    report.market_open,
  });
  if (report.feed_frozen) {
    const freezeReason = isDailyClassSource(report.candle_source)
      ? 'daily_candle_older_than_72h'
      : 'intraday_feed_stalled';
    console.warn('[FROZEN_FEED_DETECTED]', {
      context,
      candle_age_seconds: report.candle_age_seconds,
      market_open:        report.market_open,
      candle_source:      report.candle_source,
      latest_candle_iso:  report.latest_candle_ms != null
        ? new Date(report.latest_candle_ms).toISOString() : null,
      action:             'elite_gate_refuses_to_ship',
    });
    console.warn('[FREEZE_REASON]', { context, reason: freezeReason });
  } else if (report.freshness_quality === 'stale') {
    console.warn('[STALE_CANDLE_REJECT]', {
      context,
      candle_age_seconds: report.candle_age_seconds,
      market_open:        report.market_open,
      candle_source:      report.candle_source,
      action:             'aged_rows_decayed_below_floor',
    });
  }
}
