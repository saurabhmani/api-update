// ════════════════════════════════════════════════════════════════
//  Strategy Conflict Resolver — Phase 6
//
//  Resolves cases where multiple strategies fire on the same symbol
//  with disagreeing directions, or where a strategy fires alongside
//  a contradicting confirmation signal (overbought-reversal risk on
//  a bullish breakout, manipulation risk on a momentum continuation,
//  etc.).
//
//  Pure: takes pre-loaded candidates + confirmation context and
//  returns a structured decision. Never writes to the DB.
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import type { StrategyName } from '@/lib/signal-engine/types/signalEngine.types';

export type ConflictStatus = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type ConflictRecommendation = 'APPROVE' | 'WATCHLIST' | 'REJECT' | 'AVOID';

export interface CandidateLite {
  strategyId:      string;
  direction:       'BUY' | 'SELL';
  confidenceScore: number | null;
}

export interface ConflictResolverInput {
  symbol:        string;
  candidates:    CandidateLite[];
  manipulationRiskBand?:   'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE' | 'UNKNOWN' | null;
  marketRegime?: string | null;
}

export interface ConflictResolution {
  symbol:               string;
  conflictStatus:       ConflictStatus;
  conflictingStrategies: string[];
  dominantView:         'BUY' | 'SELL' | 'MIXED' | 'NONE';
  decisionImpact:       string;
  explanation:          string;
  recommendation:       ConflictRecommendation;
}

export function resolveConflicts(input: ConflictResolverInput): ConflictResolution {
  const { candidates } = input;

  if (candidates.length === 0) {
    return {
      symbol:                input.symbol,
      conflictStatus:        'NONE',
      conflictingStrategies: [],
      dominantView:          'NONE',
      decisionImpact:        'No candidates to resolve.',
      explanation:           'No active candidates for this symbol.',
      recommendation:        'WATCHLIST',
    };
  }

  const buys  = candidates.filter((c) => c.direction === 'BUY');
  const sells = candidates.filter((c) => c.direction === 'SELL');

  let conflictStatus: ConflictStatus = 'NONE';
  if (buys.length > 0 && sells.length > 0) {
    // Both directions present — magnitude matters.
    const buyConf  = avgConf(buys);
    const sellConf = avgConf(sells);
    const gap = Math.abs(buyConf - sellConf);
    conflictStatus = gap < 5 ? 'HIGH' : gap < 15 ? 'MEDIUM' : 'LOW';
  }

  // Manipulation upgrade — SEVERE/HIGH always raises conflict
  // because trap risk is incompatible with high confidence.
  if (input.manipulationRiskBand === 'SEVERE') conflictStatus = 'HIGH';
  else if (input.manipulationRiskBand === 'HIGH' && conflictStatus === 'NONE') conflictStatus = 'MEDIUM';

  const conflicting = candidates.map((c) => c.strategyId);
  const dominantView: ConflictResolution['dominantView'] =
    buys.length > 0 && sells.length === 0 ? 'BUY'
    : sells.length > 0 && buys.length === 0 ? 'SELL'
    : conflictStatus === 'NONE' ? 'BUY'                  // single-direction defaults handled above
    : 'MIXED';

  let recommendation: ConflictRecommendation = 'WATCHLIST';
  let decisionImpact: string;
  let explanation: string;

  if (input.manipulationRiskBand === 'SEVERE') {
    recommendation = 'AVOID';
    decisionImpact = 'Approval blocked due to severe manipulation risk.';
    explanation    = 'Severe trap-risk signature is incompatible with any approved direction. Avoid trading this symbol until risk subsides.';
  } else if (conflictStatus === 'HIGH') {
    recommendation = 'WATCHLIST';
    decisionImpact = 'Conflicting strategies fire with similar confidence — no clean directional view.';
    explanation    = composeExplanation(input, dominantView, conflicting);
  } else if (conflictStatus === 'MEDIUM') {
    recommendation = 'WATCHLIST';
    decisionImpact = 'Mixed directional signals — confidence gap is too small to approve either side.';
    explanation    = composeExplanation(input, dominantView, conflicting);
  } else if (conflictStatus === 'LOW') {
    // Dominant view wins with a confidence haircut.
    recommendation = 'WATCHLIST';
    decisionImpact = `Dominant direction is ${dominantView}, but opposite signal is also present — proceed with caution.`;
    explanation    = composeExplanation(input, dominantView, conflicting);
  } else {
    // No conflict.
    recommendation = 'APPROVE';
    decisionImpact = 'Strategies agree on direction.';
    explanation    = `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} all point ${dominantView}; no internal conflict.`;
  }

  return {
    symbol: input.symbol,
    conflictStatus,
    conflictingStrategies: conflicting,
    dominantView,
    decisionImpact,
    explanation,
    recommendation,
  };
}

function avgConf(xs: CandidateLite[]): number {
  const vals = xs.map((x) => x.confidenceScore).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function composeExplanation(
  input: ConflictResolverInput,
  dominantView: ConflictResolution['dominantView'],
  conflicting: string[],
): string {
  const names = conflicting.slice(0, 3).map((s) => getStrategyMeta(s as StrategyName).strategyName);
  const tail = conflicting.length > 3 ? `, and ${conflicting.length - 3} more` : '';
  const regime = input.marketRegime ? ` in a ${input.marketRegime.toLowerCase()} regime` : '';
  if (input.manipulationRiskBand === 'HIGH') {
    return `${names.join(', ')}${tail} are firing${regime}, but elevated manipulation risk reduces approval confidence. Watchlist only.`;
  }
  if (dominantView === 'MIXED') {
    return `${names.join(', ')}${tail} disagree on direction${regime}. Watchlist until one side resolves.`;
  }
  return `${names.join(', ')}${tail} agree on ${dominantView}${regime}, but a contradicting signal is also present — watchlist for confirmation.`;
}
