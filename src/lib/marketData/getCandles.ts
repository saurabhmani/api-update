// ════════════════════════════════════════════════════════════════
//  getCandles — daily-OHLC entry point for candle ingest (backfill).
//
//  Kite is the sole historical upstream. Used ONLY by `candleIngest` —
//  strategy evaluation reads from DB via `fetchDailyCandlesWithFallback`
//  and never calls this function while a scan is in flight.
//
//  Never throws. Failure returns `{ ok: false, reason }`.
// ════════════════════════════════════════════════════════════════

import {
  fetchUpstreamDailyCandles,
  getDbBarCount,
  SUFFICIENT_BAR_DEPTH,
} from './candleFallbackChain';
import {
  fetchNseHistoricalCandles,
  isNseHistoricalFetchEnabled,
} from './providers/nseHistoricalProvider';
import { ensureKiteHistoricalConfigured } from './providers/kiteHistoricalProvider';
import type { OhlcBar, CandleFetchResult, CandleSource } from './yahooCandles';

export type { OhlcBar, CandleFetchResult, CandleSource } from './yahooCandles';

export interface GetCandlesOptions {
  /** When true, call upstream even if DB already has sufficient depth. */
  incrementalRefresh?: boolean;
}

const PERMANENT_SKIP = new Set<string>(['JUNCTION']);
const INAV_PSEUDO_RE = /INAV$/;

const NEGATIVE_TTL_MS = 15 * 60 * 1_000;
const failedAt = new Map<string, number>();

function toOhlcBars(candles: Array<{
  ts: string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>): OhlcBar[] {
  return candles.map((c) => ({
    ts: new Date(c.ts as string | Date).getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

function providerReason(code: string, message?: string | null): string {
  return message ? `provider:${code}:${message}` : `provider:${code}`;
}

export async function getCandles(
  symbol: string,
  opts: GetCandlesOptions = {},
): Promise<CandleFetchResult> {
  const sym = String(symbol ?? '').trim().toUpperCase();

  if (PERMANENT_SKIP.has(sym)) {
    return { ok: false, source: 'kite', reason: 'skip:not_tradable' };
  }
  if (INAV_PSEUDO_RE.test(sym)) {
    return { ok: false, source: 'kite', reason: 'skip:inav_pseudo_symbol' };
  }

  const negAt = failedAt.get(sym);
  if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) {
    return { ok: false, source: 'kite', reason: 'neg_cache:provider_recently_failed' };
  }

  const sufficientDepth = SUFFICIENT_BAR_DEPTH();
  if (!opts.incrementalRefresh) {
    const dbCount = await getDbBarCount(sym);
    if (dbCount >= sufficientDepth) {
      console.log(
        `[CANDLE INGEST SKIP] symbol=${sym} db_bars=${dbCount} ` +
        `threshold=${sufficientDepth} reason=sufficient_depth`,
      );
      return { ok: false, source: 'db', reason: 'skip:sufficient_depth' };
    }
  }

  const kiteConfigured = await ensureKiteHistoricalConfigured();
  let upCode = 'KITE_NOT_CONFIGURED';
  let upMessage = 'No active Kite session — connect Zerodha from the dashboard';

  // 1) Kite upstream
  if (kiteConfigured) {
    const up = await fetchUpstreamDailyCandles(sym);
    if (up.ok && up.candles.length > 0) {
      failedAt.delete(sym);
      return { ok: true, candles: toOhlcBars(up.candles), source: 'kite' };
    }

    upCode = String(up.errorCode ?? 'UPSTREAM_ERROR');
    upMessage = up.errorMessage ?? upMessage;
    console.warn(
      `[getCandles] upstream failed symbol=${sym} code=${upCode} — ` +
      `${isNseHistoricalFetchEnabled() ? 'trying NSE fallback' : 'NSE fallback disabled'}`,
    );
  } else {
    console.warn(
      `[getCandles] Kite not configured for ${sym} — ` +
      `${isNseHistoricalFetchEnabled() ? 'trying NSE fallback' : 'NSE fallback disabled'}`,
    );
  }

  // 2) NSE — opt-in fallback only
  if (isNseHistoricalFetchEnabled()) {
    const nse = await fetchNseHistoricalCandles(sym);
    if (nse.ok && nse.candles.length > 0) {
      failedAt.delete(sym);
      return { ok: true, candles: toOhlcBars(nse.candles), source: 'nse' };
    }
    const nseCode = nse.errorCode ?? 'NSE_FAILED';
    failedAt.set(sym, Date.now());
    return {
      ok: false,
      source: 'nse',
      reason: providerReason(nseCode, nse.errorMessage),
    };
  }

  failedAt.set(sym, Date.now());
  return {
    ok: false,
    source: 'kite',
    reason: providerReason(upCode, upMessage),
  };
}
