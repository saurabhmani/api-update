import type { SignalOutcome } from '../types/phase4.types';

export const OUTCOME_ANALYTICS_VERSION = '3.0.0';

export interface OutcomeAnalyticsRecord {
  signalId: number;
  symbol: string;
  strategy: string;
  sector: string | null;
  marketRegime: string;
  volatilityState?: string;
  timeframe: string;
  generatedAt: string;
  predictedConfidence: number;
  expectedRewardRisk: number;
  outcome: SignalOutcome;
  topContributingFeatures?: Array<{ feature: string; score: number }>;
  manualTags?: string[];
  /** Phase 6 — optional multi-asset metadata for analytics only */
  assetClass?: string;
  strategyFamily?: string;
  marketSession?: string;
  currency?: string;
  region?: string;
}

export interface OutcomeIntelligenceSummary {
  version: string;
  sampleCount: number;
  entryTriggeredRate: number;
  stopHitRate: number;
  target1HitRate: number;
  target2HitRate: number;
  target3HitRate: number;
  avgEntryQuality: number;
  avgTimeToTargetBars: number | null;
  avgTimeToStopBars: number | null;
  avgHoldingDurationBars: number;
  avgMfePct: number;
  avgMaePct: number;
  avgRiskAdjustedReturn: number;
  avgExpectedRewardRisk: number;
  avgRealizedRewardRisk: number;
  exitReasons: Record<string, number>;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nullableMean(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value));
  return present.length === 0 ? null : round(mean(present), 2);
}

/** Pure, deterministic aggregate over canonical outcome rows. */
export function summarizeOutcomeIntelligence(
  records: readonly OutcomeAnalyticsRecord[],
): OutcomeIntelligenceSummary {
  const n = records.length;
  const outcomes = records.map((record) => record.outcome);
  const rate = (predicate: (outcome: SignalOutcome) => boolean) =>
    n === 0 ? 0 : round(outcomes.filter(predicate).length / n);

  const exitReasons: Record<string, number> = {};
  for (const outcome of outcomes) {
    const reason = outcome.exitReason ?? outcome.outcomeLabel;
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }

  return {
    version: OUTCOME_ANALYTICS_VERSION,
    sampleCount: n,
    entryTriggeredRate: rate((outcome) => outcome.entryTriggered),
    stopHitRate: rate((outcome) => outcome.stopHit),
    target1HitRate: rate((outcome) => outcome.target1Hit),
    target2HitRate: rate((outcome) => outcome.target2Hit),
    target3HitRate: rate((outcome) => outcome.target3Hit),
    avgEntryQuality: round(mean(outcomes.map((outcome) => outcome.entryQualityScore ?? 0)), 2),
    avgTimeToTargetBars: nullableMean(outcomes.map((outcome) => outcome.timeToTargetBars)),
    avgTimeToStopBars: nullableMean(outcomes.map((outcome) => outcome.timeToStopBars)),
    avgHoldingDurationBars: round(mean(outcomes.map((outcome) => outcome.holdingDurationBars ?? 0)), 2),
    avgMfePct: round(mean(outcomes.map((outcome) => outcome.maxFavorableExcursionPct)), 4),
    avgMaePct: round(mean(outcomes.map((outcome) => outcome.maxAdverseExcursionPct)), 4),
    avgRiskAdjustedReturn: round(mean(outcomes.map((outcome) => outcome.riskAdjustedReturn ?? outcome.pnlR)), 4),
    avgExpectedRewardRisk: round(mean(records.map((record) => record.expectedRewardRisk)), 4),
    avgRealizedRewardRisk: round(mean(outcomes.map((outcome) => outcome.realizedRewardRisk ?? outcome.pnlR)), 4),
    exitReasons,
  };
}
