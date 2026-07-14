// ════════════════════════════════════════════════════════════════
//  historicalIntervalMap — single mapping layer for app intervals
//  → Zerodha Kite historical intervals / windows (Phase 6).
//
//  All historical consumers (candle jobs, chart service, providers)
//  must use this module. Do not duplicate interval switch logic.
// ════════════════════════════════════════════════════════════════

import type { HistoricalRange } from '@/types/market';
import type { KiteHistoricalInterval } from '@/lib/kite/types';

/** Short aliases used in docs / ops + full ChartInterval forms. */
export type AppCandleInterval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '60m'
  | '1minute'
  | '5minute'
  | '15minute'
  | '30minute'
  | '60minute'
  | 'day'
  | '1day'
  | 'week'
  | '1week'
  | 'month'
  | '1month';

export interface KiteHistoricalWindow {
  interval: KiteHistoricalInterval;
  from: Date;
  to: Date;
}

const ALIAS_TO_CANONICAL: Record<string, AppCandleInterval> = {
  '1m': '1minute',
  '5m': '5minute',
  '15m': '15minute',
  '30m': '30minute',
  '60m': '60minute',
  '1minute': '1minute',
  '5minute': '5minute',
  '15minute': '15minute',
  '30minute': '30minute',
  '60minute': '60minute',
  day: '1day',
  '1day': '1day',
  week: '1week',
  '1week': '1week',
  month: '1month',
  '1month': '1month',
};

const APP_TO_KITE: Record<AppCandleInterval, KiteHistoricalInterval> = {
  '1m': 'minute',
  '5m': '5minute',
  '15m': '15minute',
  '30m': '30minute',
  '60m': '60minute',
  '1minute': 'minute',
  '5minute': '5minute',
  '15minute': '15minute',
  '30minute': '30minute',
  '60minute': '60minute',
  // Kite has no week/month bars — use daily and let consumers aggregate.
  day: 'day',
  '1day': 'day',
  week: 'day',
  '1week': 'day',
  month: 'day',
  '1month': 'day',
};

/** Normalize aliases (`1m` → `1minute`, `day` → `1day`). */
export function canonicalizeAppInterval(interval: string): AppCandleInterval | null {
  const key = String(interval ?? '').trim().toLowerCase();
  return ALIAS_TO_CANONICAL[key] ?? null;
}

/**
 * Map an application candle interval to a Kite Connect interval.
 * Returns null when the string is not a supported app interval.
 */
export function mapAppIntervalToKite(interval: string): KiteHistoricalInterval | null {
  const canonical = canonicalizeAppInterval(interval);
  if (!canonical) return null;
  return APP_TO_KITE[canonical];
}

/**
 * HistoricalRange (provider contract) → Kite window.
 * Mirrors the Phase 3 KiteAdapter defaults:
 *   1d  → 5minute over ~1 calendar day
 *   else → day bars over the range lookback
 */
export function rangeToKiteWindow(range: HistoricalRange): KiteHistoricalWindow {
  const to = new Date();
  const from = new Date(to.getTime());

  switch (range) {
    case '1d':
      from.setDate(from.getDate() - 1);
      return { interval: '5minute', from, to };
    case '5d':
      from.setDate(from.getDate() - 7);
      return { interval: 'day', from, to };
    case '1mo':
      from.setMonth(from.getMonth() - 1);
      return { interval: 'day', from, to };
    case '3mo':
      from.setMonth(from.getMonth() - 3);
      return { interval: 'day', from, to };
    case '6mo':
      from.setMonth(from.getMonth() - 6);
      return { interval: 'day', from, to };
    case '1y':
      from.setFullYear(from.getFullYear() - 1);
      return { interval: 'day', from, to };
    case '5y':
      from.setFullYear(from.getFullYear() - 5);
      return { interval: 'day', from, to };
    default:
      from.setFullYear(from.getFullYear() - 1);
      return { interval: 'day', from, to };
  }
}

/**
 * Chart / warehouse intervals → Kite window.
 * Defaults: intraday ≈ 30 calendar days; daily ≈ 1y; week/month ≈ 5y.
 */
export function appIntervalToKiteWindow(
  interval: string,
  fromOverride?: Date | string | null,
  toOverride?: Date | string | null,
): KiteHistoricalWindow | null {
  const kiteInterval = mapAppIntervalToKite(interval);
  const canonical = canonicalizeAppInterval(interval);
  if (!kiteInterval || !canonical) return null;

  const to = toOverride ? new Date(toOverride) : new Date();
  if (!Number.isFinite(to.getTime())) return null;

  let from: Date;
  if (fromOverride) {
    from = new Date(fromOverride);
    if (!Number.isFinite(from.getTime())) return null;
  } else {
    from = new Date(to.getTime());
    switch (canonical) {
      case '1minute':
      case '5minute':
      case '15minute':
      case '30minute':
      case '60minute':
      case '1m':
      case '5m':
      case '15m':
      case '30m':
      case '60m':
        from.setDate(from.getDate() - 30);
        break;
      case '1week':
      case 'week':
      case '1month':
      case 'month':
        from.setFullYear(from.getFullYear() - 5);
        break;
      case '1day':
      case 'day':
      default:
        from.setFullYear(from.getFullYear() - 1);
        break;
    }
  }

  return { interval: kiteInterval, from, to };
}

/** removed vendor historical_data is daily-only — map chart intervals to HistoricalRange. */
export function chartIntervalToHistoricalRange(interval: string): HistoricalRange {
  const canonical = canonicalizeAppInterval(interval);
  switch (canonical) {
    case '1minute':
    case '5minute':
    case '15minute':
    case '30minute':
    case '1m':
    case '5m':
    case '15m':
    case '30m':
      return '1mo';
    case '60minute':
    case '60m':
      return '3mo';
    case '1week':
    case 'week':
    case '1month':
    case 'month':
      return '5y';
    case '1day':
    case 'day':
    default:
      return '1y';
  }
}

/** True when the interval is sub-daily (Kite can serve; removed vendor cannot). */
export function isIntradayAppInterval(interval: string): boolean {
  const kite = mapAppIntervalToKite(interval);
  return kite != null && kite !== 'day';
}
