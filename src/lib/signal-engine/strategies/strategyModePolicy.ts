// ════════════════════════════════════════════════════════════════
//  Strategy Mode Policy
//
//  Registry-driven caps on whether a strategy may produce confirmed
//  (main-table) signals vs watchlist / developing setups only.
//  Pure module — no I/O.
// ════════════════════════════════════════════════════════════════

import { STRATEGY_REGISTRY } from './strategyRegistry';
import type { StrategyMode, StrategyName } from '../types/signalEngine.types';
import type { FinalScoreBand } from '../scoring/scoringEngine';

export type StrategyModeSignalStatus =
  | 'APPROVED_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'NO_TRADE';

export interface StrategyModeScoreContext {
  confidenceScore?: number | null;
  finalScore?:      number | null;
}

const CONFIRMED_CLASSIFICATIONS = new Set<string>([
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
]);

/** Score floors for ema_crossover — below these the effective mode is
 *  WATCHLIST_ONLY even though the registry base mode is CONFIRMED_ENABLED. */
export const EMA_CROSSOVER_CONFIRMED_MIN_FINAL      = 65;
export const EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE = 60;

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function resolveScoreGatedMode(
  strategy: StrategyName,
  baseMode: StrategyMode,
  ctx?: StrategyModeScoreContext,
): StrategyMode {
  const entry = STRATEGY_REGISTRY[strategy];
  if (!entry?.scoreGatedWatchlist) return baseMode;
  const fs = num(ctx?.finalScore);
  const cs = num(ctx?.confidenceScore);
  if (fs >= EMA_CROSSOVER_CONFIRMED_MIN_FINAL
      && cs >= EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE) {
    return 'CONFIRMED_ENABLED';
  }
  return 'WATCHLIST_ONLY';
}

/**
 * Effective strategy mode after optional score-gating (ema_crossover).
 * Unknown strategy IDs default to CONFIRMED_ENABLED for backward
 * compatibility with legacy / custom strategy names.
 */
export function resolveEffectiveStrategyMode(
  strategy: StrategyName | string | null | undefined,
  ctx?: StrategyModeScoreContext,
): StrategyMode {
  if (!strategy) return 'CONFIRMED_ENABLED';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  if (!entry) return 'CONFIRMED_ENABLED';
  return resolveScoreGatedMode(
    entry.strategyId,
    entry.strategyMode,
    ctx,
  );
}

/** True when the strategy may surface as a confirmed / main-table signal. */
export function canStrategyProduceConfirmedSignal(
  strategy: StrategyName | string | null | undefined,
  ctx?: StrategyModeScoreContext,
): boolean {
  return resolveEffectiveStrategyMode(strategy, ctx) === 'CONFIRMED_ENABLED';
}

function watchlistBand(finalScore: number): FinalScoreBand {
  return finalScore >= 50 ? 'WATCHLIST_ONLY' : 'DEVELOPING_SETUP';
}

export interface StrategyModeCapInput {
  strategy:                   StrategyName | string;
  phase4Classification:       FinalScoreBand | string;
  signalStatus?:              StrategyModeSignalStatus;
  rejectionFinalDecision?:    'approved' | 'rejected' | 'deferred';
  executionApprovalDecision?: string;
  confidenceScore?:           number | null;
  finalScore?:                number | null;
}

export interface StrategyModeCapResult {
  effectiveMode:              StrategyMode;
  phase4Classification:       FinalScoreBand;
  signalStatus?:              StrategyModeSignalStatus;
  rejectionFinalDecision?:    'approved' | 'rejected' | 'deferred';
  executionApprovalDecision?: string;
  capped:                     boolean;
  capReason?:                 string;
}

/**
 * Apply registry strategy-mode caps to pipeline outcomes.
 *
 * WATCHLIST_ONLY / EXPERIMENTAL / DISABLED strategies cannot become
 * confirmed signals but may remain as DEVELOPING_SETUP or WATCHLIST_ONLY.
 */
export function applyStrategyModeCaps(input: StrategyModeCapInput): StrategyModeCapResult {
  const effectiveMode = resolveEffectiveStrategyMode(input.strategy, {
    confidenceScore: input.confidenceScore,
    finalScore:      input.finalScore,
  });

  let phase4Classification = input.phase4Classification as FinalScoreBand;
  let signalStatus         = input.signalStatus;
  let rejectionFinalDecision    = input.rejectionFinalDecision;
  let executionApprovalDecision = input.executionApprovalDecision;
  let capped = false;
  let capReason: string | undefined;

  if (effectiveMode === 'CONFIRMED_ENABLED') {
    return {
      effectiveMode,
      phase4Classification,
      signalStatus,
      rejectionFinalDecision,
      executionApprovalDecision,
      capped: false,
    };
  }

  const cls = String(phase4Classification).toUpperCase();
  const fs  = num(input.finalScore);

  const demoteConfirmed = (): void => {
    if (CONFIRMED_CLASSIFICATIONS.has(cls)) {
      phase4Classification = watchlistBand(fs);
      capped = true;
      capReason = `strategy_mode=${effectiveMode}`;
    }
    if (signalStatus === 'APPROVED_SIGNAL') {
      signalStatus = 'DEVELOPING_SETUP';
    }
    if (rejectionFinalDecision === 'approved') {
      rejectionFinalDecision = 'deferred';
    }
    if (executionApprovalDecision === 'approved') {
      executionApprovalDecision = 'deferred';
    }
  };

  if (effectiveMode === 'DISABLED') {
    demoteConfirmed();
    if (!capped && cls !== 'NO_TRADE') {
      phase4Classification = watchlistBand(fs);
      capped = true;
      capReason = 'strategy_disabled';
    }
  } else {
    // WATCHLIST_ONLY and EXPERIMENTAL — same confirmed-signal cap.
    demoteConfirmed();
  }

  return {
    effectiveMode,
    phase4Classification,
    signalStatus,
    rejectionFinalDecision,
    executionApprovalDecision,
    capped,
    capReason,
  };
}
