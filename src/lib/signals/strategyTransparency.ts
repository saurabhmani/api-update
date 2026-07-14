// ════════════════════════════════════════════════════════════════
//  Phase 9 — Strategy performance transparency helpers
//
//  Labels sources clearly (live-observed / paper / backtested) and
//  adds Wilson CI + entry-trigger / calibration fields for the
//  strategy performance page. Pure — no DB I/O.
// ════════════════════════════════════════════════════════════════

import type { PerformanceSource } from '@/lib/strategies/strategyPerformance';

export const STRATEGY_TRANSPARENCY_VERSION = '9.0.0';

export type ResultBucketLabel =
  | 'live_observed'
  | 'paper'
  | 'backtested'
  | 'mixed'
  | 'insufficient_data';

export function labelPerformanceSource(source: PerformanceSource): ResultBucketLabel {
  switch (source) {
    case 'direct':
    case 'observed':
    case 'strategy_snapshot':
      return 'live_observed';
    case 'backtest':
      return 'backtested';
    case 'mixed':
      return 'mixed';
    case 'derived_from_candles':
    case 'estimated':
      return 'paper';
    default:
      return 'insufficient_data';
  }
}

export function performanceSourceBadgeText(source: PerformanceSource): string {
  const label = labelPerformanceSource(source);
  switch (label) {
    case 'live_observed':
      return 'Live observed';
    case 'backtested':
      return 'Backtested (simulation)';
    case 'paper':
      return 'Derived / estimated (not live)';
    case 'mixed':
      return 'Mixed sources — see breakdown';
    default:
      return 'Insufficient data';
  }
}

/** Wilson score interval for a win rate (0–1). */
export function wilsonConfidenceInterval(
  wins: number,
  n: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const p = Math.min(1, Math.max(0, wins / n));
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

export interface StrategyTransparencyBlock {
  transparencyVersion: string;
  strategyVersion: string | null;
  resolvedSampleCount: number;
  oosWinRate: number;
  oosWinRateCi: { lower: number; upper: number };
  entryTriggerRate: number | null;
  expectancyR: number;
  profitFactor: number;
  maximumDrawdownPct: number;
  averageMfe: number;
  averageMae: number;
  regimePerformanceAvailable: boolean;
  lastCalibrationDate: string | null;
  currentHealthState: string;
  performanceSource: PerformanceSource;
  performanceSourceLabel: string;
  /** Never mix buckets without this being true when sources differ. */
  sourcesClearlyLabelled: true;
}

export function buildStrategyTransparencyBlock(input: {
  strategyVersion?: string | null;
  resolvedSampleCount: number;
  winRate: number; // 0–100 or 0–1
  entryTriggerRate?: number | null;
  expectancyR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgMfe: number;
  avgMae: number;
  regimePerformanceAvailable?: boolean;
  lastCalibrationDate?: string | null;
  healthLabel: string;
  performanceSource: PerformanceSource;
}): StrategyTransparencyBlock {
  const wr01 = input.winRate > 1 ? input.winRate / 100 : input.winRate;
  const wins = Math.round(wr01 * input.resolvedSampleCount);
  const ci = wilsonConfidenceInterval(wins, input.resolvedSampleCount);
  return {
    transparencyVersion: STRATEGY_TRANSPARENCY_VERSION,
    strategyVersion: input.strategyVersion ?? null,
    resolvedSampleCount: input.resolvedSampleCount,
    oosWinRate: Math.round(wr01 * 1000) / 10,
    oosWinRateCi: {
      lower: Math.round(ci.lower * 1000) / 10,
      upper: Math.round(ci.upper * 1000) / 10,
    },
    entryTriggerRate: input.entryTriggerRate ?? null,
    expectancyR: input.expectancyR,
    profitFactor: input.profitFactor,
    maximumDrawdownPct: input.maxDrawdownPct,
    averageMfe: input.avgMfe,
    averageMae: input.avgMae,
    regimePerformanceAvailable: input.regimePerformanceAvailable ?? false,
    lastCalibrationDate: input.lastCalibrationDate ?? null,
    currentHealthState: input.healthLabel,
    performanceSource: input.performanceSource,
    performanceSourceLabel: performanceSourceBadgeText(input.performanceSource),
    sourcesClearlyLabelled: true,
  };
}
