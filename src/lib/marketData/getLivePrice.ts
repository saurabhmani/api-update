/**
 * @deprecated Live broker tick cache removed.
 * Use MarketDataProvider.getLiveSnapshot (IndianAPI warehouse) instead.
 */

import { fetchFromYahoo } from './yahoo';
import { withProviderFrame } from './enforcer';
import { logger } from '@/lib/logger';
import { formatSymbol } from './formatSymbol';

const log = logger.child({ component: 'getLivePrice' });

export type LivePriceSource = 'db' | 'yahoo' | 'none';

export interface LivePriceResult {
  symbol: string;
  price: number | null;
  source: LivePriceSource;
  ageMs: number | null;
  close?: number | null;
  open?: number | null;
  change?: number | null;
  pChange?: number | null;
  volume?: number | null;
  error?: string;
}

/** @deprecated Alias for LivePriceResult used by yahoo stub. */
export type PriceResponse = {
  price: number | null;
  source: LivePriceSource;
  error?: string;
};

export async function getLivePrice(symbol: string): Promise<LivePriceResult> {
  const sym = String(formatSymbol(symbol));
  try {
    const y = await withProviderFrame(() => fetchFromYahoo(sym));
    if (y && Number.isFinite(y.price) && y.price! > 0) {
      return {
        symbol: sym,
        price: y.price,
        source: 'yahoo',
        ageMs: null,
      };
    }
  } catch (err) {
    log.warn('yahoo live price miss', {
      symbol: sym,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    symbol: sym,
    price: null,
    source: 'none',
    ageMs: null,
    error: 'Live broker ticks unsupported; warehouse quote unavailable',
  };
}

export async function getLivePrices(
  symbols: string[],
): Promise<Record<string, LivePriceResult>> {
  const out: Record<string, LivePriceResult> = {};
  for (const s of symbols) {
    const key = String(formatSymbol(s));
    out[key] = await getLivePrice(key);
  }
  return out;
}
