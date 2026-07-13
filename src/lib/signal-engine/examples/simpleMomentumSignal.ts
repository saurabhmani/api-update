// ════════════════════════════════════════════════════════════════
//  Example: a signal-critical engine refactored to use the canonical
//  marketDataResolver. This file is intentionally small and
//  self-contained — it exists as the reference pattern every other
//  signal-engine module should follow for live LTP.
//
//  BEFORE (disallowed — direct upstream call):
//    const resp = await fetchFromYahoo(symbol);
//    if (!resp.price) return null;
//    ...
//
//  AFTER (this file — marketDataResolver):
//    const quote = await resolvePrice(symbol);
//    if (quote.quality === 'LOW' || !quote.price) return rejected;
//    ...
// ════════════════════════════════════════════════════════════════

import { resolvePrice } from '@/lib/marketData/resolver/marketDataResolver';

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
 *  trivial — the point of the file is the resolver contract, not
 *  the strategy. */
export async function evaluateMomentum(symbol: string): Promise<MomentumDecision> {
  const quote = await resolvePrice(symbol);
  if (quote.quality === 'LOW' || quote.price == null || quote.price <= 0) {
    return { kind: 'rejected', reason: 'STALE_DATA', detail: quote.quality };
  }
  const price = quote.price;
  const changePercent = Number(quote.pChange ?? 0);
  if (!Number.isFinite(changePercent)) {
    return { kind: 'rejected', reason: 'NO_DATA', detail: 'missing change percent' };
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
      symbol: quote.symbol || symbol,
      action,
      score: Math.min(100, Math.abs(changePercent) * 10),
      priceSnapshot: price,
      source: quote.source ?? 'resolver',
      dataQuality: quote.quality,
    },
  };
}
