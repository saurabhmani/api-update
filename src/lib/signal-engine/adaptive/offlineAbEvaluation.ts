// ════════════════════════════════════════════════════════════════
//  Phase 4 — Offline A/B Evaluation (no live traffic split)
// ════════════════════════════════════════════════════════════════

import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import {
  buildConfidenceCalibrationReport,
  type ConfidenceCalibrationReport,
} from '../analytics/confidenceAnalytics';
import { aggregatePerformanceMetrics } from '../analytics/performanceAnalytics';
import type { SignalEnginePhase2Config } from '../config/signalEnginePhase2Config';
import { getSignalEngineConfig } from '../config/signalEnginePhase2Config';
import type { AdaptiveParameterValues } from './adaptiveParameterTypes';
import { mergeAdaptiveOverlay } from './runtimeConfiguration';

export interface OfflineAbComparison {
  comparisonId: string;
  generatedAt: string;
  sampleSize: number;
  base: AbArmMetrics;
  candidate: AbArmMetrics;
  deltas: {
    winRate: number;
    avgReturn: number;
    maxDrawdownProxy: number;
    expectedCalibrationError: number;
    strategyDistributionL1: number;
  };
  recommendation: 'base' | 'candidate' | 'inconclusive';
}

export interface AbArmMetrics {
  label: string;
  winRate: number;
  avgReturnPct: number;
  maxDrawdownProxy: number;
  confidenceCalibration: ConfidenceCalibrationReport;
  strategyDistribution: Record<string, number>;
}

function wouldPassRejection(
  record: OutcomeAnalyticsRecord,
  config: SignalEnginePhase2Config,
): boolean {
  const rr = record.expectedRewardRisk;
  if (rr < config.rejection.minRewardRisk) return false;
  const liquidity = record.topContributingFeatures?.find((f) => f.feature.includes('liquidity'))?.score ?? 50;
  if (liquidity < config.rejection.minLiquidityQuality) return false;
  return true;
}

function filterByOverlay(
  records: readonly OutcomeAnalyticsRecord[],
  overlay: AdaptiveParameterValues | null,
): OutcomeAnalyticsRecord[] {
  const base = getSignalEngineConfig();
  const config = overlay ? mergeAdaptiveOverlay(base, overlay) : base;
  return records.filter((r) => wouldPassRejection(r, config));
}

function maxDrawdownProxy(records: readonly OutcomeAnalyticsRecord[]): number {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const r of records) {
    equity += r.outcome.realizedReturnPct ?? r.outcome.pnlR;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function strategyDistribution(records: readonly OutcomeAnalyticsRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of records) counts[r.strategy] = (counts[r.strategy] ?? 0) + 1;
  const total = records.length || 1;
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / total]));
}

function l1Distance(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum;
}

function armMetrics(
  label: string,
  records: readonly OutcomeAnalyticsRecord[],
): AbArmMetrics {
  const wins = records.filter((r) => r.outcome.target1Hit).length;
  const winRate = records.length === 0 ? 0 : wins / records.length;
  const returns = records.map((r) => r.outcome.realizedReturnPct ?? r.outcome.pnlR);
  const avgReturn = returns.length === 0 ? 0 : returns.reduce((s, v) => s + v, 0) / returns.length;
  return {
    label,
    winRate: Math.round(winRate * 10000) / 10000,
    avgReturnPct: Math.round(avgReturn * 10000) / 10000,
    maxDrawdownProxy: Math.round(maxDrawdownProxy(records) * 10000) / 10000,
    confidenceCalibration: buildConfidenceCalibrationReport(records),
    strategyDistribution: strategyDistribution(records),
  };
}

/**
 * Offline comparison: base configuration vs candidate adaptive overlay.
 * Uses historical outcomes with threshold-based filtering — no live split.
 */
export function runOfflineAbComparison(input: {
  records: readonly OutcomeAnalyticsRecord[];
  candidateOverlay: AdaptiveParameterValues;
  generatedAt?: string;
}): OfflineAbComparison {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const baseRecords = filterByOverlay(input.records, null);
  const candidateRecords = filterByOverlay(input.records, input.candidateOverlay);
  const base = armMetrics('base', baseRecords);
  const candidate = armMetrics('candidate', candidateRecords);

  const deltas = {
    winRate: candidate.winRate - base.winRate,
    avgReturn: candidate.avgReturnPct - base.avgReturnPct,
    maxDrawdownProxy: candidate.maxDrawdownProxy - base.maxDrawdownProxy,
    expectedCalibrationError:
      candidate.confidenceCalibration.expectedCalibrationError
      - base.confidenceCalibration.expectedCalibrationError,
    strategyDistributionL1: l1Distance(base.strategyDistribution, candidate.strategyDistribution),
  };

  let recommendation: OfflineAbComparison['recommendation'] = 'inconclusive';
  if (deltas.winRate > 0.02 && deltas.avgReturn > 0 && deltas.maxDrawdownProxy <= 0) {
    recommendation = 'candidate';
  } else if (deltas.winRate < -0.02 || deltas.maxDrawdownProxy > 2) {
    recommendation = 'base';
  }

  return {
    comparisonId: `ab_${generatedAt.slice(0, 10).replaceAll('-', '')}_${baseRecords.length}`,
    generatedAt,
    sampleSize: input.records.length,
    base,
    candidate,
    deltas,
    recommendation,
  };
}

/** Summarize strategy leaderboard delta for reports. */
export function summarizeStrategyPerformanceDelta(
  records: readonly OutcomeAnalyticsRecord[],
): ReturnType<typeof aggregatePerformanceMetrics> {
  return aggregatePerformanceMetrics(records, 'strategy');
}
