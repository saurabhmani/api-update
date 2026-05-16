// ════════════════════════════════════════════════════════════════
//  Slippage Model
//
//  Applies execution slippage to fill prices.
//  Slippage always hurts the trader: longs fill higher, shorts fill lower.
// ════════════════════════════════════════════════════════════════

import type { TradeDirection } from '../types';

export interface SlippageResult {
  price: number;
  cost: number;
}

/**
 * Apply slippage to a raw fill price.
 *
 * @param rawPrice - Ideal fill price before slippage
 * @param direction - Trade direction (slippage direction depends on this)
 * @param bps - Slippage in basis points (1 bps = 0.01%)
 * @returns Adjusted price and the slippage cost per unit
 */
export function applySlippage(
  rawPrice: number,
  direction: TradeDirection,
  bps: number,
): SlippageResult {
  if (bps <= 0 || rawPrice <= 0) {
    return { price: rawPrice, cost: 0 };
  }

  const factor = bps / 10000;

  if (direction === 'long') {
    // Longs: slippage makes us pay more
    const price = Math.round(rawPrice * (1 + factor) * 100) / 100;
    return { price, cost: price - rawPrice };
  } else {
    // Shorts: slippage makes us receive less
    const price = Math.round(rawPrice * (1 - factor) * 100) / 100;
    return { price, cost: rawPrice - price };
  }
}

/**
 * Calculate total slippage cost for a trade (entry + exit).
 */
export function totalSlippageCost(
  entryPrice: number,
  positionSize: number,
  bps: number,
): number {
  // Slippage on both entry and exit
  const perUnit = (entryPrice * bps / 10000) * 2;
  return Math.round(perUnit * positionSize * 100) / 100;
}
