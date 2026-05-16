// ════════════════════════════════════════════════════════════════
//  Intra-Bar Execution Assumptions
//
//  When a bar's OHLC range contains both stop and target, we need
//  to decide which was hit first. Since we only have daily bars
//  (not tick data), we use configurable assumptions about the
//  intra-bar price path.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';

/**
 * Intra-bar execution assumption models:
 *
 * 'conservative' — Stop always wins on ambiguous bars.
 *   Path: [open, low, high, close] for bullish context
 *         [open, high, low, close] for bearish context
 *   Rationale: Assumes worst-case execution. Most realistic for backtesting.
 *
 * 'optimistic' — Target always wins on ambiguous bars.
 *   Path: [open, high, low, close] for bullish context
 *         [open, low, high, close] for bearish context
 *   Rationale: Best-case execution. Use for upper-bound estimation only.
 *
 * 'open_to_high_to_low_to_close' — Fixed OHLC path.
 *   Path: [open, high, low, close]
 *   Rationale: Assumes price goes up first then down. Common assumption.
 *
 * 'open_to_low_to_high_to_close' — Inverse OHLC path.
 *   Path: [open, low, high, close]
 *   Rationale: Assumes price dips first then recovers.
 */
export type IntraBarAssumption =
  | 'conservative'
  | 'optimistic'
  | 'open_to_high_to_low_to_close'
  | 'open_to_low_to_high_to_close';

/**
 * Get the simulated intra-bar price path for execution order determination.
 * Returns an array of prices in the order they are assumed to have occurred.
 */
export function getIntraBarPricePath(
  candle: Candle,
  assumption: IntraBarAssumption,
): number[] {
  switch (assumption) {
    case 'conservative':
      // Conservative: assume worst case.
      // For a bullish bar (close > open): O → L → H → C (dip before rally)
      // For a bearish bar (close < open): O → H → L → C (rally before dip)
      if (candle.close >= candle.open) {
        return [candle.open, candle.low, candle.high, candle.close];
      } else {
        return [candle.open, candle.high, candle.low, candle.close];
      }

    case 'optimistic':
      // Optimistic: assume best case.
      if (candle.close >= candle.open) {
        return [candle.open, candle.high, candle.low, candle.close];
      } else {
        return [candle.open, candle.low, candle.high, candle.close];
      }

    case 'open_to_high_to_low_to_close':
      return [candle.open, candle.high, candle.low, candle.close];

    case 'open_to_low_to_high_to_close':
      return [candle.open, candle.low, candle.high, candle.close];
  }
}

/**
 * Determine if a price level was reached during the bar.
 */
export function wasLevelReached(candle: Candle, level: number, direction: 'above' | 'below'): boolean {
  if (direction === 'above') return candle.high >= level;
  return candle.low <= level;
}

/**
 * Determine which level was hit first in the intra-bar path.
 * Returns 'a' if levelA was hit first, 'b' if levelB, 'none' if neither.
 */
export function whichLevelFirst(
  candle: Candle,
  levelA: number,
  dirA: 'above' | 'below',
  levelB: number,
  dirB: 'above' | 'below',
  assumption: IntraBarAssumption,
): 'a' | 'b' | 'none' {
  const path = getIntraBarPricePath(candle, assumption);

  for (const price of path) {
    const aHit = dirA === 'above' ? price >= levelA : price <= levelA;
    const bHit = dirB === 'above' ? price >= levelB : price <= levelB;

    if (aHit && !bHit) return 'a';
    if (bHit && !aHit) return 'b';
    if (aHit && bHit) return 'a'; // tie goes to first argument
  }

  return 'none';
}
