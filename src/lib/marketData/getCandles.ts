// ════════════════════════════════════════════════════════════════
//  getCandles — daily-OHLC entry point for candle ingest (backfill).
//
//  Phase 6: Kite is the primary upstream; IndianAPI remains the
//  fallback. Used ONLY by `candleIngest` — strategy evaluation
//  reads from DB via `fetchDailyCandlesWithFallback` and never
//  calls this function while a scan is in flight.
//
//  Never throws. Failure returns `{ ok: false, reason }`.
// ════════════════════════════════════════════════════════════════

import { mapToIndianApiSymbol } from './symbolMapper';
import {
  fetchUpstreamDailyCandles,
  getDbBarCount,
  SUFFICIENT_BAR_DEPTH,
} from './candleFallbackChain';
import {
  fetchNseHistoricalCandles,
  isNseHistoricalFetchEnabled,
} from './providers/nseHistoricalProvider';
import { getIndianApiConfig } from './providers/indianApiEndpoints';
import { isKiteHistoricalConfigured } from './providers/kiteHistoricalProvider';
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
  const sym = (await mapToIndianApiSymbol(symbol)).toUpperCase();

  if (PERMANENT_SKIP.has(sym)) {
    return { ok: false, source: 'indianapi', reason: 'skip:not_tradable' };
  }
  if (INAV_PSEUDO_RE.test(sym)) {
    return { ok: false, source: 'indianapi', reason: 'skip:inav_pseudo_symbol' };
  }

  const negAt = failedAt.get(sym);
  if (negAt && Date.now() - negAt < NEGATIVE_TTL_MS) {
    return { ok: false, source: 'indianapi', reason: 'neg_cache:provider_recently_failed' };
  }

  const { apiKey } = getIndianApiConfig();
  if (!apiKey && !isKiteHistoricalConfigured()) {
    return {
      ok: false,
      source: 'indianapi',
      reason: providerReason('API_KEY_MISSING', 'No Kite or IndianAPI credentials configured'),
    };
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

  // 1) Kite → IndianAPI
  const up = await fetchUpstreamDailyCandles(sym);
  if (up.ok && up.candles.length > 0) {
    failedAt.delete(sym);
    const source: CandleSource = up.provider === 'kite' ? 'kite' : 'indianapi';
    return { ok: true, candles: toOhlcBars(up.candles), source };
  }

  const iaCode = String(up.errorCode ?? 'UPSTREAM_ERROR');
  console.warn(
    `[getCandles] upstream failed symbol=${sym} code=${iaCode} — ` +
    `${isNseHistoricalFetchEnabled() ? 'trying NSE fallback' : 'NSE fallback disabled'}`,
  );

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
    source: up.provider === 'kite' ? 'kite' : 'indianapi',
    reason: providerReason(iaCode, up.errorMessage),
  };
}
