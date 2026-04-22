// ════════════════════════════════════════════════════════════════
//  Signal Lifecycle Simulator
//
//  Manages pending signals: expiry, invalidation before entry,
//  deduplication, and conversion to open positions.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { PendingSignal, SimulatedSignal, BacktestRunConfig, OpenPosition } from '../types';
import { getSector } from '../../signal-engine/constants/phase3.constants';

export type SignalDisposition = 'pending' | 'triggered' | 'expired' | 'invalidated' | 'duplicate' | 'capacity_blocked';

export interface SignalStepResult {
  disposition: SignalDisposition;
  reason: string;
}

/**
 * Check if a pending signal should be expired.
 */
export function checkSignalExpiry(
  signal: PendingSignal,
  config: BacktestRunConfig,
): SignalStepResult | null {
  if (signal.barsWaited >= config.signalExpiryBars) {
    return { disposition: 'expired', reason: `Signal expired after ${signal.barsWaited} bars without entry trigger` };
  }
  return null;
}

/**
 * Check if a pending signal is invalidated by price action.
 *
 * Invalidation rules:
 * - Long: stop loss breached before entry → signal invalidated
 * - Short: stop loss breached before entry → signal invalidated
 * - Both: price moved too far from entry zone (>2x ATR drift)
 */
export function checkSignalInvalidation(
  signal: PendingSignal,
  candle: Candle,
): SignalStepResult | null {
  if (signal.direction === 'long') {
    // If price broke below stop before we entered, the setup is dead
    if (candle.low < signal.stopLoss) {
      return { disposition: 'invalidated', reason: `Price broke below stop ${signal.stopLoss} before entry` };
    }
    // If price ran away from entry zone (too expensive to chase)
    const drift = ((candle.close - signal.entryZoneHigh) / signal.entryZoneHigh) * 100;
    if (drift > 5) {
      return { disposition: 'invalidated', reason: `Price drifted ${drift.toFixed(1)}% above entry zone — too expensive` };
    }
  } else {
    if (candle.high > signal.stopLoss) {
      return { disposition: 'invalidated', reason: `Price broke above stop ${signal.stopLoss} before entry` };
    }
    const drift = ((signal.entryZoneLow - candle.close) / signal.entryZoneLow) * 100;
    if (drift > 5) {
      return { disposition: 'invalidated', reason: `Price drifted ${drift.toFixed(1)}% below entry zone — too cheap` };
    }
  }

  return null;
}

/**
 * Check for duplicate signals (same symbol already pending or open).
 */
export function checkDuplicate(
  signal: PendingSignal,
  pendingSignals: PendingSignal[],
  openPositions: OpenPosition[],
): SignalStepResult | null {
  if (pendingSignals.some(p => p.symbol === signal.symbol && p.signalId !== signal.signalId)) {
    return { disposition: 'duplicate', reason: `Already has a pending signal for ${signal.symbol}` };
  }
  if (openPositions.some(p => p.symbol === signal.symbol)) {
    return { disposition: 'duplicate', reason: `Already has an open position in ${signal.symbol}` };
  }
  return null;
}

/**
 * Check capacity constraints (max positions, sector limits).
 */
export function checkCapacity(
  signal: PendingSignal,
  openPositions: OpenPosition[],
  config: BacktestRunConfig,
): SignalStepResult | null {
  if (openPositions.length >= config.maxOpenPositions) {
    return { disposition: 'capacity_blocked', reason: `Max ${config.maxOpenPositions} open positions reached` };
  }

  // Sector limit (max 3 per sector by default)
  const sectorCount = openPositions.filter(p => getSector(p.symbol) === signal.sector).length;
  if (sectorCount >= 3) {
    return { disposition: 'capacity_blocked', reason: `Sector ${signal.sector} already has ${sectorCount} positions` };
  }

  return null;
}

/**
 * Process all pending signals for one simulation step.
 * Returns the signals grouped by their disposition.
 */
export function processSignalLifecycles(
  pendingSignals: PendingSignal[],
  candles: Map<string, Candle>,
  openPositions: OpenPosition[],
  config: BacktestRunConfig,
): {
  stillPending: PendingSignal[];
  expired: Array<{ signal: PendingSignal; reason: string }>;
  invalidated: Array<{ signal: PendingSignal; reason: string }>;
  readyForEntry: PendingSignal[];
} {
  const stillPending: PendingSignal[] = [];
  const expired: Array<{ signal: PendingSignal; reason: string }> = [];
  const invalidated: Array<{ signal: PendingSignal; reason: string }> = [];
  const readyForEntry: PendingSignal[] = [];

  for (const sig of pendingSignals) {
    sig.barsWaited++;

    // 1. Check expiry
    const expiryCheck = checkSignalExpiry(sig, config);
    if (expiryCheck) { expired.push({ signal: sig, reason: expiryCheck.reason }); continue; }

    // 2. Check invalidation
    const candle = candles.get(sig.symbol);
    if (candle) {
      const invalidCheck = checkSignalInvalidation(sig, candle);
      if (invalidCheck) { invalidated.push({ signal: sig, reason: invalidCheck.reason }); continue; }
    }

    // 3. Check capacity
    const capacityCheck = checkCapacity(sig, openPositions, config);
    if (capacityCheck) { stillPending.push(sig); continue; } // keep pending, not rejected

    // 4. Check duplicate
    const dupCheck = checkDuplicate(sig, pendingSignals.filter(p => p.signalId !== sig.signalId), openPositions);
    if (dupCheck) { stillPending.push(sig); continue; }

    // 5. Ready for entry attempt
    readyForEntry.push(sig);
  }

  return { stillPending, expired, invalidated, readyForEntry };
}
