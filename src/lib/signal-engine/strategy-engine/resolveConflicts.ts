// ════════════════════════════════════════════════════════════════
//  Conflict Resolution Engine — Phase 2
//
//  When multiple strategies match the same symbol, this engine
//  compares them on multiple dimensions and selects the winner.
//  Losers are logged for audit, not silently dropped.
// ════════════════════════════════════════════════════════════════

import type {
  StrategyCandidate, ConflictResolution, StrategyName,
  EnhancedMarketRegime, SectorContext,
} from '../types/signalEngine.types';
import { STRATEGY_REGISTRY } from '../strategies/strategyRegistry';
import { round } from '../utils/math';

/**
 * Resolve conflicts when multiple strategies match one symbol.
 *
 * Resolution criteria (in order of weight):
 * 1. Direction conflict (bullish vs bearish) → direction matching regime wins
 * 2. Regime fit (how well does strategy match current regime?) → 30% weight
 * 3. Confidence score → 35% weight
 * 4. Risk score (lower is better) → 20% weight
 * 5. Structural quality (breakout distance, support proximity) → 15% weight
 */
export function resolveConflicts(
  candidates: StrategyCandidate[],
  regime: EnhancedMarketRegime,
  sectorContext: SectorContext,
): { winner: StrategyCandidate; resolution: ConflictResolution } {
  if (candidates.length === 0) {
    throw new Error('resolveConflicts called with empty candidates');
  }

  if (candidates.length === 1) {
    return {
      winner: candidates[0],
      resolution: {
        symbol: candidates[0].features.trend.close > 0 ? '' : '',
        winningStrategy: candidates[0].strategy,
        winningScore: candidates[0].confidence.finalScore,
        losingStrategies: [],
        hadDirectionConflict: false,
        resolvedAt: new Date().toISOString(),
      },
    };
  }

  // Score each candidate on multi-dimensional fitness
  const scored = candidates.map((c) => ({
    candidate: c,
    compositeScore: computeConflictScore(c, regime, sectorContext),
  }));

  // Check for direction conflicts (bullish vs bearish)
  const directions = new Set(
    candidates.map((c) => STRATEGY_REGISTRY[c.strategy]?.direction ?? 'neutral'),
  );
  const hadDirectionConflict = directions.has('long') && directions.has('short');

  // If direction conflict exists, favor the direction that matches regime
  if (hadDirectionConflict) {
    const regimeFavorsLong = ['Strong Bullish', 'Bullish'].includes(regime.label);
    const regimeFavorsShort = ['Bearish', 'Weak'].includes(regime.label);

    if (regimeFavorsLong) {
      scored.forEach((s) => {
        if (STRATEGY_REGISTRY[s.candidate.strategy]?.direction === 'long') {
          s.compositeScore += 15; // strong boost for regime-aligned direction
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

  // Sort by composite score (highest wins)
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  const winner = scored[0];
  const losers = scored.slice(1);

  const resolution: ConflictResolution = {
    symbol: '',
    winningStrategy: winner.candidate.strategy,
    winningScore: round(winner.compositeScore),
    losingStrategies: losers.map((l) => ({
      strategy: l.candidate.strategy,
      score: round(l.compositeScore),
      suppressionReason: buildSuppressionReason(winner.candidate, l.candidate, hadDirectionConflict),
    })),
    hadDirectionConflict,
    resolvedAt: new Date().toISOString(),
  };

  return { winner: winner.candidate, resolution };
}

function computeConflictScore(
  candidate: StrategyCandidate,
  regime: EnhancedMarketRegime,
  sectorContext: SectorContext,
): number {
  const entry = STRATEGY_REGISTRY[candidate.strategy];

  // 1. Regime fit (0-100) — 30% weight
  let regimeFit = 50; // neutral default
  if (entry.allowedRegimes.includes(regime.label)) {
    // Bonus based on how well the regime matches
    regimeFit = 70;
    if (regime.label === 'Strong Bullish' && entry.direction === 'long') regimeFit = 95;
    if (regime.label === 'Bullish' && entry.direction === 'long') regimeFit = 85;
    if (regime.label === 'Bearish' && entry.direction === 'short') regimeFit = 90;
    if (regime.label === 'Weak' && entry.direction === 'short') regimeFit = 80;
  } else {
    regimeFit = 20; // penalty for regime mismatch
  }

  // 2. Confidence (0-100) — 35% weight
  const confidenceScore = candidate.confidence.finalScore;

  // 3. Risk inverse (0-100) — 20% weight
  const riskInverse = 100 - candidate.risk.totalScore;

  // 4. Structural quality (0-100) — 15% weight
  const structuralQuality = computeStructuralQuality(candidate);

  // 5. Sector alignment bonus
  let sectorBonus = 0;
  if (entry.direction === 'long' && sectorContext.sectorStrengthScore >= 65) sectorBonus = 5;
  if (entry.direction === 'short' && sectorContext.sectorStrengthScore <= 35) sectorBonus = 5;

  // 6. Registry confidence weight (some strategies are inherently more reliable)
  const registryWeight = entry.defaultConfidenceWeight;

  return (
    regimeFit * 0.30 +
    confidenceScore * 0.35 +
    riskInverse * 0.20 +
    structuralQuality * 0.15 +
    sectorBonus
  ) * registryWeight;
}

function computeStructuralQuality(candidate: StrategyCandidate): number {
  const f = candidate.features;
  let score = 50;

  // Higher lows pattern = stronger structure
  if (f.structure.consecutiveHigherLows >= 3) score += 15;
  else if (f.structure.consecutiveHigherLows >= 2) score += 8;

  // Range compression before breakout = stronger setup
  if (f.structure.rangeCompressionRatio < 0.7) score += 10;

  // Inside day = tight consolidation
  if (f.structure.isInsideDay) score += 5;

  // Clean breakout distance (0-3% ideal)
  if (f.structure.breakoutDistancePct > 0 && f.structure.breakoutDistancePct <= 3) score += 10;

  // R:R ratio quality
  if (candidate.tradePlan.rewardRiskApprox >= 2.0) score += 10;
  else if (candidate.tradePlan.rewardRiskApprox >= 1.5) score += 5;

  return Math.min(score, 100);
}

function buildSuppressionReason(
  winner: StrategyCandidate,
  loser: StrategyCandidate,
  hadDirectionConflict: boolean,
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

  const riskDiff = loser.risk.totalScore - winner.risk.totalScore;
  if (riskDiff > 10) {
    return `Risk advantage: winner risk ${winner.risk.totalScore} vs ${loser.risk.totalScore}`;
  }

  return `Lower composite score (confidence: ${loser.confidence.finalScore}, risk: ${loser.risk.totalScore})`;
}
