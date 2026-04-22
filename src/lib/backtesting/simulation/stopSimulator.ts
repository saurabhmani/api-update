// ════════════════════════════════════════════════════════════════
//  Stop Loss Simulator
//
//  Checks whether a stop loss was hit on a given bar using
//  configurable intra-bar execution assumptions.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { OpenPosition } from '../types';
import type { IntraBarAssumption } from '../utils/barExecution';
import { getIntraBarPricePath } from '../utils/barExecution';

export interface StopCheckResult {
  hit: boolean;
  exitPrice: number;
  /** Bar sequence index where stop was hit (within OHLC path) */
  hitAtStep: number;
}

/**
 * Check if a stop loss was triggered on this bar.
 *
 * Uses the intra-bar price path assumption to determine
 * WHEN during the bar the stop was touched.
 */
export function checkStopLoss(
  pos: OpenPosition,
  candle: Candle,
  assumption: IntraBarAssumption,
): StopCheckResult {
  const path = getIntraBarPricePath(candle, assumption);

  for (let step = 0; step < path.length; step++) {
    const price = path[step];
    if (pos.direction === 'long' && price <= pos.stopLoss) {
      return { hit: true, exitPrice: pos.stopLoss, hitAtStep: step };
    }
    if (pos.direction === 'short' && price >= pos.stopLoss) {
      return { hit: true, exitPrice: pos.stopLoss, hitAtStep: step };
    }
  }

  return { hit: false, exitPrice: 0, hitAtStep: -1 };
}
