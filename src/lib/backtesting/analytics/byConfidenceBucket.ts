// ════════════════════════════════════════════════════════════════
//  Analytics By Confidence Bucket
//
//  Critical for Dexter AI integration: validates whether higher
//  confidence scores actually produce better outcomes.
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';
import { computeMfeMaeStats } from '../metrics/mfeMae';

export interface ConfidenceBucketAnalytics {
  bucket: string;
  bucketLow: number;
  bucketHigh: number;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  avgReturnR: number;
  profitFactor: number;
  expectancyR: number;
  avgMfePct: number;
  avgMaePct: number;
  edgeRatio: number;
  target1HitRate: number;
  stopHitRate: number;
  avgBarsHeld: number;
}

const BUCKETS = [
  { label: '50-59', low: 50, high: 60 },
  { label: '60-69', low: 60, high: 70 },
  { label: '70-79', low: 70, high: 80 },
  { label: '80-89', low: 80, high: 90 },
  { label: '90-100', low: 90, high: 101 },
];

export function analyzeByConfidenceBucket(trades: SimulatedTrade[]): ConfidenceBucketAnalytics[] {
  return BUCKETS.map(bucket => {
    const bTrades = trades.filter(t => t.confidenceScore >= bucket.low && t.confidenceScore < bucket.high);
    const n = bTrades.length;
    if (n === 0) {
      return {
        bucket: bucket.label, bucketLow: bucket.low, bucketHigh: bucket.high,
        trades: 0, winRate: 0, avgReturnPct: 0, avgReturnR: 0, profitFactor: 0,
        expectancyR: 0, avgMfePct: 0, avgMaePct: 0, edgeRatio: 0,
        target1HitRate: 0, stopHitRate: 0, avgBarsHeld: 0,
      };
    }

    const wins = bTrades.filter(t => t.outcome === 'win');
    const exp = computeExpectancy(bTrades);
    const mfe = computeMfeMaeStats(bTrades);

    return {
      bucket: bucket.label, bucketLow: bucket.low, bucketHigh: bucket.high,
      trades: n,
      winRate: r(wins.length / n),
      avgReturnPct: r(bTrades.reduce((s, t) => s + t.returnPct, 0) / n),
      avgReturnR: r(bTrades.reduce((s, t) => s + t.returnR, 0) / n),
      profitFactor: exp.profitFactor,
      expectancyR: exp.expectancyR,
      avgMfePct: mfe.avgMfePct, avgMaePct: mfe.avgMaePct, edgeRatio: mfe.edgeRatio,
      target1HitRate: r(bTrades.filter(t => t.target1Hit).length / n),
      stopHitRate: r(bTrades.filter(t => t.stopHit).length / n),
      avgBarsHeld: r(bTrades.reduce((s, t) => s + t.barsInTrade, 0) / n),
    };
  });
}

/**
 * Check if confidence scores are monotonically useful:
 * higher buckets should have better metrics than lower buckets.
 */
export function isConfidenceMonotonic(buckets: ConfidenceBucketAnalytics[]): {
  monotonic: boolean;
  violations: string[];
} {
  const violations: string[] = [];
  const valid = buckets.filter(b => b.trades >= 5);

  for (let i = 1; i < valid.length; i++) {
    if (valid[i].winRate < valid[i - 1].winRate - 0.05) {
      violations.push(`Win rate drops: ${valid[i].bucket} (${valid[i].winRate}) < ${valid[i-1].bucket} (${valid[i-1].winRate})`);
    }
    if (valid[i].expectancyR < valid[i - 1].expectancyR - 0.1) {
      violations.push(`Expectancy drops: ${valid[i].bucket} (${valid[i].expectancyR}R) < ${valid[i-1].bucket} (${valid[i-1].expectancyR}R)`);
    }
  }

  return { monotonic: violations.length === 0, violations };
}

function r(v: number): number { return Math.round(v * 100) / 100; }
