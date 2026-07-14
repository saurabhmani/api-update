// ════════════════════════════════════════════════════════════════
//  Signal Ranking — Phase 1 + Phase 6 diversity controls
//
//  Diversity/concentration controls affect publication order only —
//  not underlying setup confidence.
// ════════════════════════════════════════════════════════════════

import type { QuantSignal } from '../types/signalEngine.types';
import type { CorrelationMatrix } from '../correlation/correlationEngine';
import { getSector } from '../constants/phase3.constants';

export const RANK_DIVERSITY_VERSION = '6.0.0';

export interface RankDiversityOptions {
  /** Max signals per sector in the top published list (soft demote after). */
  maxPerSector?: number;
  /** Max signals per strategy id. */
  maxPerStrategy?: number;
  /** Max highly correlated peers in the published head. */
  maxCorrelatedPeers?: number;
  /** Absolute correlation threshold for peer demotion. */
  correlationThreshold?: number;
  correlationMatrix?: CorrelationMatrix | null;
  /** Soft demote same factor family (breakout vs breakout). */
  maxSameCategory?: number;
}

const DEFAULT_DIVERSITY: Required<Omit<RankDiversityOptions, 'correlationMatrix'>> & {
  correlationMatrix: CorrelationMatrix | null;
} = {
  maxPerSector: 3,
  maxPerStrategy: 2,
  maxCorrelatedPeers: 2,
  correlationThreshold: 0.7,
  maxSameCategory: 3,
  correlationMatrix: null,
};

export function rankSignals(
  signals: QuantSignal[],
  diversity?: RankDiversityOptions,
): QuantSignal[] {
  const rankable = signals.filter((s) => s.confidenceBand !== 'Avoid');
  const excluded = signals.filter((s) => s.confidenceBand === 'Avoid');

  const scored = rankable.map((s) => ({
    signal: s,
    compositeScore: computeRankScore(s),
  }));

  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  const diversified = applyDiversityControls(
    scored.map((x) => x.signal),
    { ...DEFAULT_DIVERSITY, ...diversity },
  );

  const ranked = diversified.map((signal, index) => ({
    ...signal,
    rank: index + 1,
  }));

  const unranked = excluded.map((s) => ({ ...s, rank: 0 }));
  return [...ranked, ...unranked];
}

function computeRankScore(s: QuantSignal): number {
  const confidenceComponent = s.confidenceScore * 0.35;
  const riskComponent = (100 - s.riskScore) * 0.20;

  const volRatio = Math.max(1, s.features.volume.volumeVs20dAvg);
  const volumeComponent = Math.min(Math.log(volRatio) / Math.log(10) * 50, 100) * 0.15;

  const bDist = s.features.structure.breakoutDistancePct;
  const structureScore = bDist > 0 && bDist <= 2 ? 90
    : bDist > 0 && bDist <= 3 ? 75
    : bDist > 0 && bDist <= 5 ? 50
    : 20;
  const structureComponent = structureScore * 0.15;

  const rrScore = Math.min(s.rewardRiskApprox * 30, 100);
  const rrComponent = rrScore * 0.15;

  return confidenceComponent + riskComponent + volumeComponent + structureComponent + rrComponent;
}

function strategyCategory(signalType: string): string {
  if (signalType.includes('breakout') || signalType.includes('gap') || signalType.includes('squeeze')) {
    return 'breakout_factor';
  }
  if (signalType.includes('pullback') || signalType.includes('fibonacci')) {
    return 'pullback_factor';
  }
  if (signalType.includes('momentum') || signalType.includes('ema_crossover')) {
    return 'momentum_factor';
  }
  if (
    signalType.includes('mean_reversion')
    || signalType.includes('oversold')
    || signalType.includes('divergence')
    || signalType.includes('climax')
    || signalType.includes('overbought')
  ) {
    return 'mean_reversion_factor';
  }
  if (signalType.includes('breakdown') || signalType.includes('rejection')) {
    return 'breakdown_factor';
  }
  return 'other_factor';
}

function pairCorr(
  matrix: CorrelationMatrix | null | undefined,
  a: string,
  b: string,
): number | null {
  if (!matrix) return null;
  const hit = matrix.pairs.find(
    (p) =>
      (p.symbolA === a && p.symbolB === b) || (p.symbolA === b && p.symbolB === a),
  );
  return hit ? Math.abs(hit.correlation) : null;
}

/**
 * Greedy diversify: keep composite order, demote when concentration caps hit.
 * Demoted signals remain in the list (after head) so confidence is unchanged.
 */
function applyDiversityControls(
  ordered: QuantSignal[],
  opts: Required<Omit<RankDiversityOptions, 'correlationMatrix'>> & {
    correlationMatrix: CorrelationMatrix | null;
  },
): QuantSignal[] {
  const kept: QuantSignal[] = [];
  const deferred: QuantSignal[] = [];
  const sectorCount = new Map<string, number>();
  const strategyCount = new Map<string, number>();
  const categoryCount = new Map<string, number>();

  for (const s of ordered) {
    const sector = (s as QuantSignal & { sectorContext?: { sector?: string } }).sectorContext?.sector
      ?? getSector(s.symbol);
    const strategy = s.signalType;
    const category = strategyCategory(strategy);

    const sN = (sectorCount.get(sector) ?? 0) + 1;
    const stN = (strategyCount.get(strategy) ?? 0) + 1;
    const cN = (categoryCount.get(category) ?? 0) + 1;

    let corrPeers = 0;
    if (opts.correlationMatrix) {
      for (const k of kept) {
        const c = pairCorr(opts.correlationMatrix, s.symbol, k.symbol);
        if (c != null && c >= opts.correlationThreshold) corrPeers++;
      }
    }

    const overConcentrated =
      sN > opts.maxPerSector
      || stN > opts.maxPerStrategy
      || cN > opts.maxSameCategory
      || corrPeers >= opts.maxCorrelatedPeers;

    if (overConcentrated) {
      deferred.push({
        ...s,
        warnings: [
          ...s.warnings,
          `rank_diversity_demote: sector/strategy/correlation concentration (v${RANK_DIVERSITY_VERSION})`,
        ],
      });
      continue;
    }

    sectorCount.set(sector, sN);
    strategyCount.set(strategy, stN);
    categoryCount.set(category, cN);
    kept.push(s);
  }

  return [...kept, ...deferred];
}
