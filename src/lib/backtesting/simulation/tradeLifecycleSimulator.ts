// ════════════════════════════════════════════════════════════════
//  Trade Lifecycle Simulator
//
//  Manages the full lifecycle of an open position bar by bar:
//  1. Update MFE/MAE excursions
//  2. Check stop loss (priority 1)
//  3. Check targets (priority 2, ordered)
//  4. Check time expiry
//  5. Track bar-by-bar P&L
//
//  Uses configurable intra-bar execution assumptions to resolve
//  ambiguous bars where both stop and target are in range.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { OpenPosition, ExitReason, BacktestRunConfig } from '../types';
import type { IntraBarAssumption } from '../utils/barExecution';
import { checkStopLoss } from './stopSimulator';
import { checkTargets } from './targetSimulator';
import { updateExcursions } from './tradeSimulator';

export interface LifecycleStepResult {
  /** Should the position be closed? */
  shouldExit: boolean;
  /** Exit price (if exiting) */
  exitPrice: number;
  /** Reason for exit */
  exitReason: ExitReason | null;
  /** Updated target flags */
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  stopHit: boolean;
  /** Updated MFE/MAE */
  mfePct: number;
  maePct: number;
  /** This bar's unrealized P&L */
  barPnl: number;
}

/**
 * Process one bar for an open position.
 * Returns whether to exit and all updated tracking data.
 */
export function processPositionBar(
  pos: OpenPosition,
  candle: Candle,
  barsInTrade: number,
  config: BacktestRunConfig,
  assumption: IntraBarAssumption = 'conservative',
): LifecycleStepResult {
  // 1. Update excursions
  const excursions = updateExcursions(pos, candle);

  // 2. Check stop loss first (highest priority)
  const stopResult = checkStopLoss(pos, candle, assumption);

  // 3. Check targets
  const targetResult = checkTargets(pos, candle, assumption);

  // 4. Determine exit
  let shouldExit = false;
  let exitPrice = 0;
  let exitReason: ExitReason | null = null;
  let stopHit = false;

  if (stopResult.hit && targetResult.highestTargetHit) {
    // BOTH stop and target hit on same bar — use assumption
    if (assumption === 'conservative') {
      // Conservative: stop wins
      shouldExit = true;
      exitPrice = stopResult.exitPrice;
      exitReason = 'stop_loss';
      stopHit = true;
    } else if (assumption === 'optimistic') {
      // Optimistic: highest target wins
      shouldExit = true;
      exitPrice = targetResult.exitPrice;
      exitReason = targetResult.highestTargetHit;
    } else {
      // OHLC path: whoever was hit first in the path wins
      if (stopResult.hitAtStep <= targetResult.hitAtStep) {
        shouldExit = true;
        exitPrice = stopResult.exitPrice;
        exitReason = 'stop_loss';
        stopHit = true;
      } else {
        shouldExit = true;
        exitPrice = targetResult.exitPrice;
        exitReason = targetResult.highestTargetHit;
      }
    }
  } else if (stopResult.hit) {
    shouldExit = true;
    exitPrice = stopResult.exitPrice;
    exitReason = 'stop_loss';
    stopHit = true;
  } else if (targetResult.highestTargetHit === 'target3') {
    // Exit on T3 (full target achieved)
    shouldExit = true;
    exitPrice = targetResult.exitPrice;
    exitReason = 'target3';
  } else if (targetResult.highestTargetHit === 'target2' && !pos.target2Hit) {
    // Exit on T2 (good followthrough)
    shouldExit = true;
    exitPrice = targetResult.exitPrice;
    exitReason = 'target2';
  }

  // 5. Time expiry check
  if (!shouldExit && barsInTrade >= config.evaluationHorizon) {
    shouldExit = true;
    exitPrice = candle.close;
    exitReason = 'time_expiry';
  }

  // 6. Bar P&L
  const barPnl = pos.direction === 'long'
    ? (candle.close - pos.entryPrice) * pos.positionSize
    : (pos.entryPrice - candle.close) * pos.positionSize;

  return {
    shouldExit,
    exitPrice: Math.round(exitPrice * 100) / 100,
    exitReason,
    target1Hit: targetResult.target1Hit,
    target2Hit: targetResult.target2Hit,
    target3Hit: targetResult.target3Hit,
    stopHit,
    mfePct: excursions.mfePct,
    maePct: excursions.maePct,
    barPnl: Math.round(barPnl * 100) / 100,
  };
}
