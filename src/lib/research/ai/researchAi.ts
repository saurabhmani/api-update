// ════════════════════════════════════════════════════════════════
//  Phase 7 — AI Research Interfaces (research only — no production)
// ════════════════════════════════════════════════════════════════

import type { ResearchFeatureVector, ResearchFeatureName } from '../features/researchFeatures';
import { RESEARCH_FEATURE_CATALOG } from '../features/researchFeatures';
import type { ResearchCandle } from '../types';

export interface FeatureImportanceResult {
  rankings: Array<{ feature: ResearchFeatureName; importance: number; explanation: string }>;
}

export interface ClusterResult {
  clusterId: number;
  symbols: string[];
  centroid: Record<string, number>;
  explanation: string;
}

export interface RegimeDiscoveryResult {
  regimes: Array<{ label: string; barRange: [number, number]; characteristics: Record<string, number> }>;
  explanation: string;
}

export interface AnomalyResult {
  barIndex: number;
  score: number;
  explanation: string;
}

export interface ParameterOptimizationResult {
  bestParameters: Record<string, number>;
  gridResults: Array<{ parameters: Record<string, number>; score: number }>;
  explanation: string;
}

export interface SymbolSimilarityResult {
  pairs: Array<{ symbolA: string; symbolB: string; similarity: number; explanation: string }>;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

export function analyzeFeatureImportance(
  vectors: readonly ResearchFeatureVector[],
  targets: number[],
): FeatureImportanceResult {
  const rankings = RESEARCH_FEATURE_CATALOG.map((feature) => {
    const xs = vectors.map((v) => v.features[feature]);
    const corr = Math.abs(pearson(xs, targets.slice(0, xs.length)));
    return {
      feature,
      importance: Math.round(corr * 10000) / 10000,
      explanation: `Absolute correlation with target: ${corr.toFixed(3)}`,
    };
  }).sort((a, b) => b.importance - a.importance);
  return { rankings };
}

export function clusterSymbols(
  featureBySymbol: Record<string, Record<string, number>>,
): ClusterResult[] {
  const symbols = Object.keys(featureBySymbol);
  if (symbols.length === 0) return [];
  const clusters: ClusterResult[] = [
    { clusterId: 0, symbols: [], centroid: {}, explanation: 'High momentum cluster' },
    { clusterId: 1, symbols: [], centroid: {}, explanation: 'Mean-reversion cluster' },
  ];
  for (const sym of symbols) {
    const f = featureBySymbol[sym];
    const score = (f.trend_persistence ?? 0) + (f.relative_strength ?? 0);
    clusters[score >= 0 ? 0 : 1].symbols.push(sym);
  }
  return clusters.filter((c) => c.symbols.length > 0);
}

export function discoverRegimes(
  vectors: readonly ResearchFeatureVector[],
  windowSize = 20,
): RegimeDiscoveryResult {
  const regimes: RegimeDiscoveryResult['regimes'] = [];
  for (let i = 0; i < vectors.length; i += windowSize) {
    const chunk = vectors.slice(i, i + windowSize);
    if (chunk.length === 0) continue;
    const avgVol = chunk.reduce((s, v) => s + v.features.volatility_clustering, 0) / chunk.length;
    const avgTrend = chunk.reduce((s, v) => s + v.features.trend_persistence, 0) / chunk.length;
    const label = avgVol > 1.2 ? 'high_volatility' : avgTrend > 0.2 ? 'trending' : 'range_bound';
    regimes.push({
      label,
      barRange: [chunk[0].barIndex, chunk[chunk.length - 1].barIndex],
      characteristics: { volatility: avgVol, trend: avgTrend },
    });
  }
  return {
    regimes,
    explanation: 'Regimes discovered via rolling volatility and trend persistence thresholds',
  };
}

export function detectAnomalies(vectors: readonly ResearchFeatureVector[]): AnomalyResult[] {
  const scores = vectors.map((v) => v.features.entropy);
  const mean = scores.reduce((s, v) => s + v, 0) / (scores.length || 1);
  const std = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length || 1));
  return vectors
    .map((v) => ({
      barIndex: v.barIndex,
      score: std === 0 ? 0 : Math.abs(v.features.entropy - mean) / std,
      explanation: 'Entropy z-score anomaly',
    }))
    .filter((a) => a.score > 2)
    .slice(0, 10);
}

export function optimizeParameters(
  grid: Array<Record<string, number>>,
  scoreFn: (params: Record<string, number>) => number,
): ParameterOptimizationResult {
  const gridResults = grid.map((parameters) => ({
    parameters,
    score: scoreFn(parameters),
  })).sort((a, b) => b.score - a.score);
  return {
    bestParameters: gridResults[0]?.parameters ?? {},
    gridResults,
    explanation: 'Grid search over research parameter space — not promoted to production',
  };
}

export function computeSymbolSimilarity(
  seriesBySymbol: Record<string, ResearchCandle[]>,
): SymbolSimilarityResult {
  const symbols = Object.keys(seriesBySymbol);
  const pairs: SymbolSimilarityResult['pairs'] = [];
  for (let i = 0; i < symbols.length; i += 1) {
    for (let j = i + 1; j < symbols.length; j += 1) {
      const a = seriesBySymbol[symbols[i]].map((c) => c.close);
      const b = seriesBySymbol[symbols[j]].map((c) => c.close);
      const sim = pearson(a, b);
      pairs.push({
        symbolA: symbols[i],
        symbolB: symbols[j],
        similarity: Math.round(sim * 10000) / 10000,
        explanation: `Return correlation similarity: ${sim.toFixed(3)}`,
      });
    }
  }
  return { pairs: pairs.sort((a, b) => b.similarity - a.similarity) };
}
