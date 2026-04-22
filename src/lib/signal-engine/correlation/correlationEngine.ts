// ════════════════════════════════════════════════════════════════
//  Correlation Engine — Phase 3
//
//  Rolling return correlation between stocks for portfolio risk.
//  Uses Pearson correlation on daily returns over a configurable
//  lookback window. Falls back to sector-based clustering when
//  insufficient data is available.
// ════════════════════════════════════════════════════════════════

import type { Candle, StrategyName } from '../types/signalEngine.types';
import type { CorrelationSnapshot, PortfolioPosition, Phase3Config } from '../types/phase3.types';
import { closes } from '../utils/candles';
import { getSector } from '../constants/phase3.constants';
import { round } from '../utils/math';

// ── Configuration ──────────────────────────────────────────
const DEFAULT_LOOKBACK = 60;      // 60 trading days (~3 months)
const HIGH_CORR_THRESHOLD = 0.70; // above this = correlated pair
const MIN_DATA_POINTS = 30;       // minimum returns for reliable correlation

// ── Pair Correlation ───────────────────────────────────────
export interface PairCorrelation {
  symbolA: string;
  symbolB: string;
  correlation: number;
  dataPoints: number;
  isHighlyCorrelated: boolean;
}

export interface CorrelationMatrix {
  pairs: PairCorrelation[];
  clusters: CorrelationCluster[];
}

export interface CorrelationCluster {
  name: string;
  symbols: string[];
  avgCorrelation: number;
  source: 'return_correlation' | 'sector_proxy';
}

/**
 * Compute Pearson correlation between two return series.
 */
export function pearsonCorrelation(returnsA: number[], returnsB: number[]): number {
  const n = Math.min(returnsA.length, returnsB.length);
  if (n < MIN_DATA_POINTS) return NaN;

  let sumA = 0, sumB = 0, sumAB = 0, sumA2 = 0, sumB2 = 0;

  for (let i = 0; i < n; i++) {
    sumA += returnsA[i];
    sumB += returnsB[i];
    sumAB += returnsA[i] * returnsB[i];
    sumA2 += returnsA[i] * returnsA[i];
    sumB2 += returnsB[i] * returnsB[i];
  }

  const numerator = n * sumAB - sumA * sumB;
  const denominator = Math.sqrt(
    (n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB),
  );

  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Convert candle series to daily returns.
 */
export function dailyReturns(candles: Candle[], lookback = DEFAULT_LOOKBACK): number[] {
  const c = closes(candles);
  const start = Math.max(0, c.length - lookback - 1);
  const returns: number[] = [];

  for (let i = start + 1; i < c.length; i++) {
    if (c[i - 1] > 0) {
      returns.push((c[i] - c[i - 1]) / c[i - 1]);
    }
  }
  return returns;
}

/**
 * Build a correlation matrix for a set of symbols with their candle data.
 */
export function buildCorrelationMatrix(
  candleMap: Map<string, Candle[]>,
  lookback = DEFAULT_LOOKBACK,
): CorrelationMatrix {
  const symbols = Array.from(candleMap.keys());
  const returnsMap = new Map<string, number[]>();

  for (const sym of symbols) {
    const candles = candleMap.get(sym);
    if (candles && candles.length > MIN_DATA_POINTS) {
      returnsMap.set(sym, dailyReturns(candles, lookback));
    }
  }

  const pairs: PairCorrelation[] = [];

  const symList = Array.from(returnsMap.keys());
  for (let i = 0; i < symList.length; i++) {
    for (let j = i + 1; j < symList.length; j++) {
      const returnsA = returnsMap.get(symList[i])!;
      const returnsB = returnsMap.get(symList[j])!;
      const corr = pearsonCorrelation(returnsA, returnsB);

      if (!isNaN(corr)) {
        pairs.push({
          symbolA: symList[i],
          symbolB: symList[j],
          correlation: round(corr, 3),
          dataPoints: Math.min(returnsA.length, returnsB.length),
          isHighlyCorrelated: Math.abs(corr) >= HIGH_CORR_THRESHOLD,
        });
      }
    }
  }

  // Build clusters from highly correlated pairs
  const clusters = buildClusters(pairs, symbols);

  return { pairs, clusters };
}

/**
 * Build correlation clusters from pair correlations.
 * Groups symbols that are transitively correlated above threshold.
 */
function buildClusters(
  pairs: PairCorrelation[],
  allSymbols: string[],
): CorrelationCluster[] {
  const highPairs = pairs.filter((p) => p.isHighlyCorrelated);

  // Union-find for clustering
  const parent = new Map<string, string>();
  for (const sym of allSymbols) parent.set(sym, sym);

  function find(x: string): string {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  }

  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const pair of highPairs) {
    union(pair.symbolA, pair.symbolB);
  }

  // Group by root
  const groups = new Map<string, string[]>();
  for (const sym of allSymbols) {
    const root = find(sym);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(sym);
  }

  const clusters: CorrelationCluster[] = [];
  const groupEntries = Array.from(groups.entries());
  for (const [, members] of groupEntries) {
    if (members.length < 2) continue;

    // Compute average correlation within cluster
    const clusterPairs = highPairs.filter(
      (p) => members.includes(p.symbolA) && members.includes(p.symbolB),
    );
    const avgCorr = clusterPairs.length > 0
      ? round(clusterPairs.reduce((s, p) => s + p.correlation, 0) / clusterPairs.length, 3)
      : 0;

    clusters.push({
      name: `corr_cluster_${members.slice(0, 3).join('_')}`,
      symbols: members,
      avgCorrelation: avgCorr,
      source: 'return_correlation',
    });
  }

  return clusters;
}

/**
 * Evaluate correlation penalty for a new signal against existing portfolio.
 * Uses real correlation data when available, falls back to sector clustering.
 */
export function evaluateCorrelationPenalty(
  symbol: string,
  existingPositions: PortfolioPosition[],
  correlationMatrix?: CorrelationMatrix,
  config?: Phase3Config,
): CorrelationSnapshot {
  const maxCluster = config?.maxCorrelationClusterCount ?? 3;

  // Try real correlation first
  if (correlationMatrix && correlationMatrix.pairs.length > 0) {
    const correlatedSymbols = correlationMatrix.pairs
      .filter((p) =>
        p.isHighlyCorrelated &&
        (p.symbolA === symbol || p.symbolB === symbol),
      )
      .map((p) => p.symbolA === symbol ? p.symbolB : p.symbolA);

    const correlatedInPortfolio = existingPositions.filter(
      (pos) => correlatedSymbols.includes(pos.symbol),
    );

    const clusterCount = correlatedInPortfolio.length;
    let penalty = 0;

    if (clusterCount >= maxCluster) {
      penalty = Math.min(30, (clusterCount - maxCluster + 1) * 10);
    } else if (clusterCount >= 2) {
      penalty = 5;
    }

    // Find which cluster this symbol belongs to
    const cluster = correlationMatrix.clusters.find(
      (c) => c.symbols.includes(symbol),
    );

    return {
      correlationCluster: cluster?.name ?? getSector(symbol),
      clusterExposureCount: clusterCount,
      correlationPenalty: penalty,
    };
  }

  // Fallback: sector-based clustering
  const sector = getSector(symbol);
  const sectorCount = existingPositions.filter((p) => p.sector === sector).length;

  let penalty = 0;
  if (sectorCount >= maxCluster) {
    penalty = Math.min(25, (sectorCount - maxCluster + 1) * 8);
  } else if (sectorCount >= 2) {
    penalty = 4;
  }

  return {
    correlationCluster: sector,
    clusterExposureCount: sectorCount,
    correlationPenalty: penalty,
  };
}
