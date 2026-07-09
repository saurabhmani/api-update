// ════════════════════════════════════════════════════════════════
//  resolveMarketCandles — market-aware candle source router
//
//  Market OPEN  + live feed healthy → warehouse daily history +
//                                   live session bar (live_tick)
//  Market OPEN  + feed stale       → warehouse daily only (daily)
//  Market CLOSED                   → warehouse daily only (daily)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '@/lib/signal-engine';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import {
  resolveActiveCandleSource,
  liveFeedBlocksApprovals,
  getLiveFeedState,
} from '@/lib/marketData/liveFeedState';
import {
  getLiveSessionBar,
  getLiveSessionCandle,
} from '@/lib/marketData/liveSessionBarStore';
import {
  fetchDailyCandlesWithFallback,
  type CandleFetchResult,
} from '@/lib/marketData/candleFallbackChain';

export type MarketCandleSource = 'live_tick' | 'daily';

export interface MarketCandleResult {
  candles:       Candle[];
  source:        MarketCandleSource;
  livePrice:     number | null;
  sessionBar:    ReturnType<typeof getLiveSessionBar>;
  feedQuality:   ReturnType<typeof getLiveFeedState>['quality'];
  approvalsBlocked: boolean;
  warehouseBars: number;
}

const DB_BARS_LIMIT = 300;

async function loadWarehouseDailyBars(symbol: string): Promise<Candle[]> {
  const { rows } = await db.query(
    `SELECT ts, open, high, low, close, volume FROM (
       SELECT ts, open, high, low, close, volume
         FROM market_data_daily
        WHERE symbol = ?
        ORDER BY ts DESC
        LIMIT ?
     ) t
     ORDER BY ts ASC`,
    [symbol, DB_BARS_LIMIT],
  );
  return (rows as any[]).map((r) => ({
    ts:     String(r.ts),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume),
  }));
}

function sessionDateFromTs(ts: string): string {
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : ts.slice(0, 10);
}

/** Merge warehouse history with the in-memory live session bar. */
function mergeLiveSessionBar(
  warehouse: Candle[],
  liveCandle: Candle,
  sessionDate: string,
): Candle[] {
  if (warehouse.length === 0) return [liveCandle];

  const out = [...warehouse];
  const last = out[out.length - 1];
  const lastDate = sessionDateFromTs(last.ts);

  if (lastDate === sessionDate) {
    out[out.length - 1] = liveCandle;
  } else if (lastDate < sessionDate) {
    out.push(liveCandle);
  } else {
    // Warehouse already has a newer bar — prefer live for the session.
    out.push(liveCandle);
  }

  if (out.length > DB_BARS_LIMIT) {
    return out.slice(out.length - DB_BARS_LIMIT);
  }
  return out;
}

export interface ResolveMarketCandlesOpts {
  /** Force daily warehouse even when market is open (bulk scan in-flight). */
  forceDaily?: boolean;
  quiet?: boolean;
}

/**
 * Primary entry for signal generation and live analysis.
 * Never mixes stale live ticks when feed is classified stale.
 */
export async function resolveMarketCandles(
  symbol: string,
  opts: ResolveMarketCandlesOpts = {},
): Promise<MarketCandleResult> {
  const sym = symbol.trim().toUpperCase();
  const feed = getLiveFeedState();
  const marketOpen = isMarketOpen();
  const useLive = marketOpen
    && !opts.forceDaily
    && resolveActiveCandleSource() === 'live_tick';

  let warehouse: Candle[];
  try {
    warehouse = await loadWarehouseDailyBars(sym);
  } catch {
    warehouse = [];
  }

  const liveBar = getLiveSessionBar(sym);
  const liveCandle = liveBar ? getLiveSessionCandle(sym) : null;

  if (useLive && liveCandle && liveBar) {
    const merged = mergeLiveSessionBar(warehouse, liveCandle, liveBar.sessionDate);
    return {
      candles:          merged,
      source:           'live_tick',
      livePrice:        liveBar.close,
      sessionBar:       liveBar,
      feedQuality:      feed.quality,
      approvalsBlocked: liveFeedBlocksApprovals(),
      warehouseBars:    warehouse.length,
    };
  }

  // Off-hours or feed unhealthy — daily warehouse path.
  if (warehouse.length >= 30) {
    return {
      candles:          warehouse,
      source:           'daily',
      livePrice:        liveBar?.close ?? null,
      sessionBar:       liveBar,
      feedQuality:      feed.quality,
      approvalsBlocked: marketOpen && liveFeedBlocksApprovals(),
      warehouseBars:    warehouse.length,
    };
  }

  // Thin warehouse — fall back to upstream daily chain (ingest only).
  const chain: CandleFetchResult = await fetchDailyCandlesWithFallback(sym);
  return {
    candles:          chain.candles,
    source:           'daily',
    livePrice:        liveBar?.close ?? null,
    sessionBar:       liveBar,
    feedQuality:      feed.quality,
    approvalsBlocked: marketOpen && liveFeedBlocksApprovals(),
    warehouseBars:    chain.candles.length,
  };
}

/** Convenience wrapper matching CandleProvider.fetchDailyCandles signature. */
export async function fetchCandlesForSignalEngine(
  symbol: string,
  opts: ResolveMarketCandlesOpts = {},
): Promise<Candle[]> {
  const result = await resolveMarketCandles(symbol, opts);
  return result.candles;
}
