// ════════════════════════════════════════════════════════════════
//  Conflict Resolution Engine — Phase 2 + Phase 6
//
//  When multiple strategies match the same symbol, this engine
//  compares them on multiple dimensions and selects the winner.
//  Losers are logged for audit, not silently dropped.
//
//  Phase 6: correlation-aware consensus; contradictory elite-quality
//  long+short cannot both publish as elite.
// ════════════════════════════════════════════════════════════════

import type {
  StrategyCandidate, ConflictResolution, StrategyName,
  EnhancedMarketRegime, SectorContext,
} from '../types/signalEngine.types';
import { STRATEGY_REGISTRY } from '../strategies/strategyRegistry';
import { getEffectiveStrategyEntryFields } from '@/lib/strategy-hub/effectiveStrategyConfig';
import { round } from '../utils/math';
import {
  consensusFromCandidate,
  type ConsensusResult,
} from '../consensus/correlationAwareConsensus';

function readSignalTier(
  confidence: StrategyCandidate['confidence'],
): 'Elite' | 'Actionable' | 'Watchlist' | 'Avoid' | null {
  if ('signalTier' in confidence && confidence.signalTier) {
    return confidence.signalTier;
  }
  return null;
}

export interface ConflictResolveExtras {
  /** Soft-block when both long and short are high-quality with no clear winner. */
  unresolvedConflictNoTrade?: boolean;
  /** Neither side may claim Elite when directions conflict. */
  eliteBlockedForSymbol?: boolean;
  winnerConsensus?: ConsensusResult;
}

/**
 * Resolve conflicts when multiple strategies match one symbol.
 *
 * Resolution criteria (in order of weight):
 * 1. Direction conflict (bullish vs bearish) → direction matching regime wins
 * 2. Regime fit (how well does strategy match current regime?) → 25% weight
 * 3. Confidence score → 30% weight
 * 4. Consensus (independent families) → 15% weight
 * 5. Risk score (lower is better) → 15% weight
 * 6. Structural quality → 15% weight
 */
export function resolveConflicts(
  candidates: StrategyCandidate[],
  regime: EnhancedMarketRegime,
  sectorContext: SectorContext,
): {
  winner: StrategyCandidate;
  resolution: ConflictResolution;
  extras: ConflictResolveExtras;
} {
  if (candidates.length === 0) {
    throw new Error('resolveConflicts called with empty candidates');
  }

  if (candidates.length === 1) {
    const consensus = consensusFromCandidate(candidates[0]);
    return {
      winner: candidates[0],
      resolution: {
        symbol: '',
        winningStrategy: candidates[0].strategy,
        winningScore: candidates[0].confidence.finalScore,
        losingStrategies: [],
        hadDirectionConflict: false,
        resolvedAt: new Date().toISOString(),
      },
      extras: { winnerConsensus: consensus },
    };
  }

  const consensusMap = new Map<StrategyName, ConsensusResult>();
  for (const c of candidates) {
    consensusMap.set(c.strategy, consensusFromCandidate(c));
  }

  const scored = candidates.map((c) => ({
    candidate: c,
    compositeScore: computeConflictScore(
      c,
      regime,
      sectorContext,
      consensusMap.get(c.strategy)?.consensusScore ?? 50,
    ),
    consensus: consensusMap.get(c.strategy)!,
  }));

  const directions = new Set(
    candidates.map((c) => STRATEGY_REGISTRY[c.strategy]?.direction ?? 'neutral'),
  );
  const hadDirectionConflict = directions.has('long') && directions.has('short');

  if (hadDirectionConflict) {
    const regimeFavorsLong = ['Strong Bullish', 'Bullish'].includes(regime.label);
    const regimeFavorsShort = ['Bearish', 'Weak'].includes(regime.label);

    if (regimeFavorsLong) {
      scored.forEach((s) => {
        if (STRATEGY_REGISTRY[s.candidate.strategy]?.direction === 'long') {
          s.compositeScore += 15;
        }
      });
    } else if (regimeFavorsShort) {
      scored.forEach((s) => {
        if (STRATEGY_REGISTRY[s.candidate.strategy]?.direction === 'short') {
          s.compositeScore += 15;
        }
      });
    }
  }

  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  const winner = scored[0];
  const losers = scored.slice(1);

  // Phase 6 — elite conflict policy
  const highQuality = (s: (typeof scored)[0]) => {
    const tier = readSignalTier(s.candidate.confidence);
    return (
      s.candidate.confidence.finalScore >= 70
      && (tier === 'Elite' || tier === 'Actionable' || s.consensus.broadSupport)
    );
  };

  let eliteBlockedForSymbol = false;
  let unresolvedConflictNoTrade = false;

  if (hadDirectionConflict) {
    const longHQ = scored.filter(
      (s) => STRATEGY_REGISTRY[s.candidate.strategy]?.direction === 'long' && highQuality(s),
    );
    const shortHQ = scored.filter(
      (s) => STRATEGY_REGISTRY[s.candidate.strategy]?.direction === 'short' && highQuality(s),
    );
    if (longHQ.length > 0 && shortHQ.length > 0) {
      eliteBlockedForSymbol = true;
      const gap = Math.abs(scored[0].compositeScore - (scored[1]?.compositeScore ?? 0));
      if (gap < 8) {
        unresolvedConflictNoTrade = true;
      }
    }
  }

  const resolution: ConflictResolution = {
    symbol: '',
    winningStrategy: winner.candidate.strategy,
    winningScore: round(winner.compositeScore),
    losingStrategies: losers.map((l) => ({
      strategy: l.candidate.strategy,
      score: round(l.compositeScore),
      suppressionReason: buildSuppressionReason(
        winner.candidate,
        l.candidate,
        hadDirectionConflict,
        winner.consensus.consensusScore,
        l.consensus.consensusScore,
      ),
    })),
    hadDirectionConflict,
    resolvedAt: new Date().toISOString(),
  };

  return {
    winner: winner.candidate,
    resolution,
    extras: {
      unresolvedConflictNoTrade,
      eliteBlockedForSymbol,
      winnerConsensus: winner.consensus,
    },
  };
}

function computeConflictScore(
  candidate: StrategyCandidate,
  regime: EnhancedMarketRegime,
  sectorContext: SectorContext,
  consensusScore: number,
): number {
  const entry = STRATEGY_REGISTRY[candidate.strategy];
  const effective = getEffectiveStrategyEntryFields(candidate.strategy) ?? entry;

  let regimeFit = 50;
  if (effective.allowedRegimes.includes(regime.label)) {
    regimeFit = 70;
    if (regime.label === 'Strong Bullish' && entry.direction === 'long') regimeFit = 95;
    if (regime.label === 'Bullish' && entry.direction === 'long') regimeFit = 85;
    if (regime.label === 'Bearish' && entry.direction === 'short') regimeFit = 90;
    if (regime.label === 'Weak' && entry.direction === 'short') regimeFit = 80;
  } else {
    regimeFit = 20;
  }

  const confidenceScore = candidate.confidence.finalScore;
  const riskInverse = 100 - candidate.risk.totalScore;
  const structuralQuality = computeStructuralQuality(candidate);

  let sectorBonus = 0;
  if (entry.direction === 'long' && sectorContext.sectorStrengthScore >= 65) sectorBonus = 5;
  if (entry.direction === 'short' && sectorContext.sectorStrengthScore <= 35) sectorBonus = 5;

  const registryWeight = effective.defaultConfidenceWeight;

  return (
    (
      regimeFit * 0.25
      + confidenceScore * 0.30
      + consensusScore * 0.15
      + riskInverse * 0.15
      + structuralQuality * 0.15
      + sectorBonus
    ) * registryWeight
  );
}

function computeStructuralQuality(candidate: StrategyCandidate): number {
  const f = candidate.features;
  let score = 50;

  if (f.structure.consecutiveHigherLows >= 3) score += 15;
  else if (f.structure.consecutiveHigherLows >= 2) score += 8;

  if (f.structure.rangeCompressionRatio < 0.7) score += 10;
  if (f.structure.isInsideDay) score += 5;
  if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 3) score += 10;

  if (candidate.tradePlan.rewardRiskApprox >= 2.0) score += 10;
  else if (candidate.tradePlan.rewardRiskApprox >= 1.5) score += 5;

  if (candidate.strategy === 'fibonacci_pullback' && f.structure.fibZoneMatched) {
    score += 12;
  }

  return Math.min(score, 100);
}

function buildSuppressionReason(
  winner: StrategyCandidate,
  loser: StrategyCandidate,
  hadDirectionConflict: boolean,
  winnerConsensus: number,
  loserConsensus: number,
): string {
  if (hadDirectionConflict) {
    const winDir = STRATEGY_REGISTRY[winner.strategy]?.direction;
    const loseDir = STRATEGY_REGISTRY[loser.strategy]?.direction;
    if (winDir !== loseDir) {
      return `Direction conflict: ${loseDir} signal suppressed in favor of regime-aligned ${winDir} signal`;
    }
  }

  const confDiff = winner.confidence.finalScore - loser.confidence.finalScore;
  if (confDiff > 10) {
    return `Confidence gap: winner ${winner.confidence.finalScore} vs ${loser.confidence.finalScore}`;
  }

  if (winnerConsensus - loserConsensus > 10) {
    return `Consensus gap: winner ${winnerConsensus} vs ${loserConsensus} (independent families)`;
  }

  const riskDiff = loser.risk.totalScore - winner.risk.totalScore;
  if (riskDiff > 10) {
    return `Risk advantage: winner risk ${winner.risk.totalScore} vs ${loser.risk.totalScore}`;
  }

  return `Lower composite score (confidence: ${loser.confidence.finalScore}, risk: ${loser.risk.totalScore})`;
}
