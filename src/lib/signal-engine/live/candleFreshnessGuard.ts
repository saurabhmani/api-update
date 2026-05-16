/**
 * Candle freshness guard — calendar-aware.
 *
 * Why this file was rewritten
 * ────────────────────────────
 * The old implementation compared `Date.now() - MAX(ts)` against a
 * fixed hour count (26h). That's wrong because:
 *
 *   1. Kite's `/instruments/historical/{token}/day` endpoint timestamps
 *      each day-bar with the *market open* (09:15 IST), not the close.
 *   2. Today's bar is not published by Kite until AFTER market close
 *      (15:30 IST). During the live session, the freshest day-bar
 *      Kite will give you is ALWAYS yesterday's.
 *   3. That means "latest candle age" during an active session
 *      naturally ranges from 24h (at 09:15 IST today) up to 30h
 *      (at 15:30 IST today) — and a 26h cutoff rejects the correct
 *      freshest-available value for half the trading day.
 *
 * Correct definition of "fresh":
 *
 *   MARKET OPEN  (weekday 09:15–15:30 IST)
 *     The most recent finalized day-bar is YESTERDAY's (the previous
 *     trading day). We accept any bar whose IST calendar date is
 *     `today − 1` or newer.
 *
 *   MARKET CLOSED after 15:30 IST on a weekday
 *     Today's bar has just been published. Ideally we have TODAY's
 *     bar, but we still accept yesterday's for a short window in case
 *     Kite hasn't finalized the day yet. So: date >= `today − 1`.
 *
 *   MARKET CLOSED overnight / weekend / holiday
 *     The most recent finalized bar is the last trading day's. We
 *     don't know the holiday calendar, so we accept anything whose
 *     IST date is within the last 5 calendar days (covers a long
 *     weekend + one holiday).
 *
 * This makes the guard honest about what Kite actually provides and
 * removes the "27.8h — too old!" false positive during market hours.
 */

import { db } from '@/lib/db';
import { getMarketStatus } from '@/lib/marketData/marketHours';

/**
 * Max number of calendar days (IST) we'll tolerate between the
 * latest candle and today before blocking the pipeline when the
 * market is closed (weekend / holiday gap).
 */
const OFFHOURS_MAX_GAP_DAYS =
  Number(process.env.CANDLE_FRESHNESS_OFFHOURS_MAX_DAYS) || 5;

/**
 * Max calendar-day gap tolerated while the market is open. 2 =
 * yesterday's or the day-before's bar is acceptable, which gives us
 * one day of slack against Yahoo/NSE publishing hiccups. This guard
 * is now advisory — it never blocks pipeline execution, only warns.
 */
const INSESSION_MAX_GAP_DAYS =
  Number(process.env.CANDLE_FRESHNESS_INSESSION_MAX_DAYS) || 2;

export interface CandleFreshnessResult {
  ok:                   boolean;
  latestCandleTs:       string | null;   // ISO string
  ageHours:             number | null;
  /** Calendar-day gap between today (IST) and the latest bar's date. */
  gapDays:              number | null;
  /** Max calendar-day gap used for the verdict. */
  maxGapDays:           number;
  /** Whether the market is currently open — surfaces in API responses. */
  marketOpen:           boolean;
  marketLabel:          string;
  reason?:              string;
  /** Legacy field kept for back-compat with older log lines and UI
   *  code. Reports the effective hour cutoff implied by maxGapDays. */
  maxAgeHours:          number;
}

/**
 * Convert a UTC Date to IST and return `YYYY-MM-DD` for the IST
 * calendar day. The ts stored in `candles` is already in UTC, so
 * we add 5h30m and then read the date components.
 */
function istDateKey(utcDate: Date): string {
  const ist = new Date(utcDate.getTime() + 5.5 * 3_600_000);
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Number of calendar days between two IST date keys (a < b).
 * Purely string-based so we don't get fooled by DST (IST has none,
 * but we stay consistent with istDateKey's UTC arithmetic).
 */
function daysBetweenIstKeys(earlier: string, later: string): number {
  const e = new Date(`${earlier}T00:00:00Z`).getTime();
  const l = new Date(`${later}T00:00:00Z`).getTime();
  return Math.round((l - e) / 86_400_000);
}

export async function checkCandleFreshness(
  _unusedLegacyHoursOverride?: number,
): Promise<CandleFreshnessResult> {
  const market = getMarketStatus();
  const maxGapDays = market.isOpen
    ? INSESSION_MAX_GAP_DAYS
    : OFFHOURS_MAX_GAP_DAYS;

  try {
    const r = await db.query(
      `SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`,
    );
    const raw = (r.rows[0] as { ts: number | string | null } | undefined)?.ts;

    if (!raw) {
      return {
        ok:             false,
        latestCandleTs: null,
        ageHours:       null,
        gapDays:        null,
        maxGapDays,
        maxAgeHours:    maxGapDays * 24,
        marketOpen:     market.isOpen,
        marketLabel:    market.label,
        reason:         'market_data_daily is empty — ingest has never run',
      };
    }

    const latestMs   = Number(raw) * 1000;
    const latestDate = new Date(latestMs);
    const todayKey   = istDateKey(new Date());
    const latestKey  = istDateKey(latestDate);
    const gapDays    = daysBetweenIstKeys(latestKey, todayKey);
    const ageHours   = Math.round(((Date.now() - latestMs) / 3_600_000) * 10) / 10;

    const ok = gapDays <= maxGapDays;

    return {
      ok,
      latestCandleTs: latestDate.toISOString(),
      ageHours,
      gapDays,
      maxGapDays,
      // Legacy field — expressed as days × 24 so any older logger
      // that reads `maxAgeHours` still produces sensible output.
      maxAgeHours:    maxGapDays * 24,
      marketOpen:     market.isOpen,
      marketLabel:    market.label,
      reason: ok
        ? undefined
        : market.isOpen
          ? `latest candle is from ${latestKey} (${gapDays} calendar days before today ${todayKey}, > ${maxGapDays}d in-session cutoff) — ingest is behind`
          : `latest candle is from ${latestKey} (${gapDays} calendar days before today ${todayKey}, > ${maxGapDays}d off-hours cutoff) — even yesterday's bar is missing`,
    };
  } catch (err) {
    return {
      ok:             false,
      latestCandleTs: null,
      ageHours:       null,
      gapDays:        null,
      maxGapDays,
      maxAgeHours:    maxGapDays * 24,
      marketOpen:     market.isOpen,
      marketLabel:    market.label,
      reason:         `candle freshness probe failed: ${(err as Error).message}`,
    };
  }
}
