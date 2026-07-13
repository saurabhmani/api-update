// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Features (discovery only — not production)
// ════════════════════════════════════════════════════════════════

import type { ResearchCandle } from '../types';

export const RESEARCH_FEATURE_CATALOG = [
  'market_breadth',
  'volume_profile',
  'anchored_vwap',
  'order_flow_proxy',
  'relative_strength',
  'volatility_clustering',
  'trend_persistence',
  'fractal_dimension',
  'entropy',
  'hurst_exponent',
  'rolling_correlation',
  'market_internals',
] as const;

export type ResearchFeatureName = typeof RESEARCH_FEATURE_CATALOG[number];

export interface ResearchFeatureVector {
  symbol: string;
  barIndex: number;
  features: Record<ResearchFeatureName, number>;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

function returns(candles: ResearchCandle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    out.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
  }
  return out;
}

function hurstExponent(series: number[]): number {
  if (series.length < 20) return 0.5;
  const n = Math.floor(series.length / 2);
  const first = series.slice(0, n);
  const second = series.slice(n);
  const rs1 = std(first) === 0 ? 0 : (Math.max(...first) - Math.min(...first)) / std(first);
  const rs2 = std(second) === 0 ? 0 : (Math.max(...second) - Math.min(...second)) / std(second);
  if (rs1 <= 0 || rs2 <= 0) return 0.5;
  return Math.max(0, Math.min(1, Math.log(rs2 / rs1) / Math.log(2)));
}

function shannonEntropy(series: number[], bins = 10): number {
  if (series.length === 0) return 0;
  const min = Math.min(...series);
  const max = Math.max(...series);
  if (max === min) return 0;
  const counts = new Array(bins).fill(0);
  for (const v of series) {
    const idx = Math.min(bins - 1, Math.floor(((v - min) / (max - min)) * bins));
    counts[idx] += 1;
  }
  const n = series.length;
  return -counts.reduce((s, c) => {
    if (c === 0) return s;
    const p = c / n;
    return s + p * Math.log2(p);
  }, 0);
}

function fractalDimension(series: number[]): number {
  if (series.length < 4) return 1;
  let length = 0;
  for (let i = 1; i < series.length; i += 1) length += Math.abs(series[i] - series[i - 1]);
  const range = Math.max(...series) - Math.min(...series);
  if (range <= 0) return 1;
  return Math.min(2, 1 + Math.log(length / range) / Math.log(series.length));
}

export function computeResearchFeatures(
  symbol: string,
  candles: ResearchCandle[],
  benchmark?: ResearchCandle[],
): ResearchFeatureVector[] {
  const rets = returns(candles);
  const out: ResearchFeatureVector[] = [];

  for (let i = 20; i < candles.length; i += 1) {
    const window = candles.slice(i - 20, i + 1);
    const winRets = rets.slice(Math.max(0, i - 20), i);
    const up = winRets.filter((r) => r > 0).length;
    const breadth = winRets.length === 0 ? 0.5 : up / winRets.length;
    const vwapNum = window.reduce((s, c) => s + c.close * c.volume, 0);
    const vwapDen = window.reduce((s, c) => s + c.volume, 0);
    const anchoredVwap = vwapDen === 0 ? window[window.length - 1].close : vwapNum / vwapDen;
    const volProfile = window[window.length - 1].volume / mean(window.map((c) => c.volume));
    const orderFlowProxy = (window[window.length - 1].close - window[0].open) / window[0].open;
    let relativeStrength = 0;
    if (benchmark && benchmark.length > i) {
      const bRet = (benchmark[i].close - benchmark[i - 1].close) / benchmark[i - 1].close;
      const sRet = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
      relativeStrength = sRet - bRet;
    }
    const volCluster = std(winRets) / (Math.abs(mean(winRets)) + 1e-6);
    const trendPersistence = mean(winRets.map((r) => Math.sign(r)));
    const closes = window.map((c) => c.close);

    out.push({
      symbol,
      barIndex: i,
      features: {
        market_breadth: Math.round(breadth * 10000) / 10000,
        volume_profile: Math.round(volProfile * 10000) / 10000,
        anchored_vwap: Math.round(anchoredVwap * 100) / 100,
        order_flow_proxy: Math.round(orderFlowProxy * 10000) / 10000,
        relative_strength: Math.round(relativeStrength * 10000) / 10000,
        volatility_clustering: Math.round(volCluster * 10000) / 10000,
        trend_persistence: Math.round(trendPersistence * 10000) / 10000,
        fractal_dimension: Math.round(fractalDimension(closes) * 10000) / 10000,
        entropy: Math.round(shannonEntropy(winRets) * 10000) / 10000,
        hurst_exponent: Math.round(hurstExponent(closes) * 10000) / 10000,
        rolling_correlation: benchmark && benchmark.length > i
          ? Math.round(pearson(closes, benchmark.slice(i - 20, i + 1).map((c) => c.close)) * 10000) / 10000
          : 0,
        market_internals: Math.round((breadth + trendPersistence) / 2 * 10000) / 10000,
      },
    });
  }
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
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

export function discoverSignificantFeatures(
  vectors: readonly ResearchFeatureVector[],
  returnByBar: Record<number, number>,
  minAbsCorrelation = 0.1,
): Array<{ feature: ResearchFeatureName; correlation: number; explanation: string }> {
  const results: Array<{ feature: ResearchFeatureName; correlation: number; explanation: string }> = [];
  for (const name of RESEARCH_FEATURE_CATALOG) {
    const xs = vectors.map((v) => v.features[name]);
    const ys = vectors.map((v) => returnByBar[v.barIndex] ?? 0);
    const corr = pearson(xs, ys);
    if (Math.abs(corr) >= minAbsCorrelation) {
      results.push({
        feature: name,
        correlation: Math.round(corr * 10000) / 10000,
        explanation: `${name} correlation with forward return: ${corr.toFixed(3)}`,
      });
    }
  }
  return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}
