// ════════════════════════════════════════════════════════════════
//  Example: a signal-critical engine refactored to use the new
//  MarketDataProvider. This file is intentionally small and
//  self-contained — it exists as the reference pattern every other
//  engine should follow when migrating off direct Yahoo/Kite calls.
//
//  BEFORE (disallowed — direct upstream call):
//    const resp = await fetchFromYahoo(symbol);
//    if (!resp.price) return null;
//    ...
//
//  AFTER (this file — provider + signal-critical flag):
//    const snap = await MarketDataProvider.getLiveSnapshot(symbol,
//      { signalCritical: true });
//    ...
//
//  Because signalCritical=true, the provider will THROW a
//  StaleDataError if it has to serve DB-layer data. The engine
//  catches it and marks the signal rejected with a specific reason,
//  which the surrounding rejection-audit infrastructure understands.
// ════════════════════════════════════════════════════════════════

import MarketDataProvider from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';

export interface MomentumSignal {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  score: number;
  priceSnapshot: number;
  source: string;
  dataQuality: string;
}

export type MomentumDecision =
  | { kind: 'signal'; signal: MomentumSignal }
  | { kind: 'rejected'; reason: 'STALE_DATA' | 'INSUFFICIENT_MOVE' | 'NO_DATA'; detail?: string };

/** Simple intraday momentum: rising > +1.5% vs prevClose → buy,
 *  falling < -1.5% → sell, otherwise hold. This is deliberately
 *  trivial — the point of the file is the provider contract, not
 *  the strategy. */
export async function evaluateMomentum(symbol: string): Promise<MomentumDecision> {
  try {
    const resp = await MarketDataProvider.getLiveSnapshot(symbol, { signalCritical: true });
    const { price, prevClose, changePercent } = resp.data;
    if (!price || !prevClose) {
      return { kind: 'rejected', reason: 'NO_DATA', detail: 'zero price or prevClose' };
    }
    const THRESHOLD = 1.5;
    const action: MomentumSignal['action'] =
      changePercent >  THRESHOLD ? 'buy'  :
      changePercent < -THRESHOLD ? 'sell' : 'hold';
    if (action === 'hold') {
      return { kind: 'rejected', reason: 'INSUFFICIENT_MOVE', detail: `${changePercent.toFixed(2)}%` };
    }
    return {
      kind: 'signal',
      signal: {
        symbol: resp.data.symbol,
        action,
        score: Math.min(Math.abs(changePercent) / 5, 1),
        priceSnapshot: price,
        source: resp.source,
        dataQuality: resp.data_quality,
      },
    };
  } catch (err) {
    if (err instanceof StaleDataError) {
      return {
        kind: 'rejected',
        reason: 'STALE_DATA',
        detail: `source=${err.response.source} quality=${err.response.data_quality}`,
      };
    }
    throw err;
  }
}
