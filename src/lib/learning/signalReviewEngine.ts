// ════════════════════════════════════════════════════════════════
//  Signal Review / Learning Engine — Phase 6
//
//  Reviews matured historical signals against actual price action
//  and emits structured insight tags. Phase 6 is RECOMMENDATION-
//  ONLY: it never rewrites strategy logic, never auto-disables a
//  strategy, never silently mutates scoring.
//
//  Inputs are the Phase-2 `PerformanceOutcomeRow` shape, which the
//  caller (the /api/strategies/learning route) loads from observed
//  snapshots + backtest trades.
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta }      from '@/lib/signal-engine/strategies/strategyRegistry';
import {
  buildPerformanceReport,
  type PerformanceOutcomeRow,
  type PerformanceWindow,
  type StrategyPerformance,
} from '@/lib/strategies/strategyPerformance';

export type LearningTag =
  | 'false_breakout'
  | 'early_entry'
  | 'late_entry'
  | 'stop_too_tight'
  | 'target_too_far'
  | 'regime_mismatch'
  | 'sector_confirmed'
  | 'option_flow_contradicted'
  | 'data_stale'
  | 'execution_weak'
  | 'high_calibration_drift';

export type LearningRecommendation =
  | 'Promote'
  | 'Keep Active'
  | 'Watch Carefully'
  | 'Reduce Approval Weight'
  | 'Human Review Required'
  | 'Insufficient Data';

export interface StrategyLearningReview {
  strategyId:        string;
  strategyName:      string;
  reviewStatus:      'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT_DATA';
  totalReviewed:     number;
  whatWorked:        string[];
  whatFailed:        string[];
  calibrationNotes:  string[];
  learningTags:      LearningTag[];
  recommendation:    LearningRecommendation;
  explanation:       string;
}

export interface StrategyRankingEntry {
  rank:           number;
  strategyId:     string;
  strategyName:   string;
  healthLabel:    string;
  recommendation: LearningRecommendation;
  explanation:    string;
}

export interface LearningReport {
  generatedAt:           string;
  timeWindow:            PerformanceWindow;
  learningStatus:        'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT_DATA';
  totalReviewedSignals:  number;
  strategyRankings:      StrategyRankingEntry[];
  reviews:               StrategyLearningReview[];
  conflictInsights:      string[];
  calibrationWarnings:   string[];
  recommendations:       Array<{
    strategyId:     string;
    strategyName:   string;
    action:         LearningRecommendation;
    explanation:    string;
  }>;
  dataQuality: {
    status:                 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
    evaluatedSignals:       number;
    minimumRequiredSignals: number;
    warnings:               string[];
  };
}

// Auto-control feature flag (recommendation-only by default). The
// learning report exposes the same recommendations either way; this
// flag only governs whether a downstream worker may act on them.
export function isAutoStrategyControlEnabled(): boolean {
  return String(process.env.AUTO_STRATEGY_CONTROL_ENABLED ?? '').toLowerCase() === 'true';
}

/**
 * Pure orchestration over already-loaded outcomes. Caller loads from
 * the same Phase-2 DB sources.
 */
export function buildLearningReport(
  outcomes: PerformanceOutcomeRow[],
  window: PerformanceWindow = '90D',
): LearningReport {
  const { report } = buildPerformanceReport(outcomes, window);

  const reviews: StrategyLearningReview[] = report.strategies.map((s) =>
    buildReviewForStrategy(s, outcomes.filter((o) => o.strategyId === s.strategyId)),
  );

  const strategyRankings: StrategyRankingEntry[] = report.leaderboard
    .map((e) => ({
      rank:          e.rank,
      strategyId:    e.strategyId,
      strategyName:  e.strategyName,
      healthLabel:   e.healthLabel,
      recommendation: toLearningRecommendation(e.recommendation),
      explanation:   reviewExplanation(e.healthLabel, e.expectancy, e.evaluatedSignals),
    }));

  const calibrationWarnings: string[] = [];
  for (const r of reviews) {
    for (const note of r.calibrationNotes) calibrationWarnings.push(`${r.strategyName}: ${note}`);
  }

  const conflictInsights = buildConflictInsights(outcomes, report.strategies);

  const recommendations = reviews
    .filter((r) => r.reviewStatus !== 'INSUFFICIENT_DATA')
    .map((r) => ({
      strategyId:   r.strategyId,
      strategyName: r.strategyName,
      action:       r.recommendation,
      explanation:  r.explanation,
    }));

  const learningStatus: LearningReport['learningStatus'] =
    report.dataStatus === 'SUFFICIENT' ? 'SUFFICIENT'
    : report.dataStatus === 'LIMITED'  ? 'LIMITED'
                                       : 'INSUFFICIENT_DATA';

  return {
    generatedAt:          new Date().toISOString(),
    timeWindow:           window,
    learningStatus,
    totalReviewedSignals: report.totalSignalsEvaluated,
    strategyRankings,
    reviews,
    conflictInsights,
    calibrationWarnings,
    recommendations,
    dataQuality: {
      status:                 report.dataQuality.status,
      evaluatedSignals:       report.dataQuality.evaluatedSignals,
      minimumRequiredSignals: report.dataQuality.minimumRequiredSignals,
      warnings:               report.dataQuality.warnings,
    },
  };
}

function buildReviewForStrategy(
  perf: StrategyPerformance,
  rows: PerformanceOutcomeRow[],
): StrategyLearningReview {
  const meta = getStrategyMeta(perf.strategyId);
  const reviewStatus: StrategyLearningReview['reviewStatus'] =
    perf.performanceStatus === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA'
    : perf.performanceStatus === 'LIMITED'         ? 'LIMITED'
                                                   : 'SUFFICIENT';

  if (reviewStatus === 'INSUFFICIENT_DATA') {
    return {
      strategyId:       perf.strategyId,
      strategyName:     meta.strategyName,
      reviewStatus,
      totalReviewed:    perf.evaluatedSignals,
      whatWorked:       [],
      whatFailed:       [],
      calibrationNotes: [],
      learningTags:     [],
      recommendation:   'Insufficient Data',
      explanation:      'Not enough evaluated signals to derive learning observations for this strategy.',
    };
  }

  const whatWorked: string[] = [];
  const whatFailed: string[] = [];
  const learningTags: LearningTag[] = [];

  if (perf.winRate >= 55)                whatWorked.push(`Win rate ${perf.winRate.toFixed(0)}% on the evaluated window.`);
  if (perf.expectancy >= 0.5)            whatWorked.push(`Positive expectancy of ${perf.expectancy.toFixed(2)}R per trade.`);
  if (perf.profitFactor >= 1.5)          whatWorked.push(`Profit factor ${perf.profitFactor.toFixed(2)} — gross wins comfortably exceed losses.`);
  if (perf.maxFavorableExcursionAvg > 0 && Math.abs(perf.maxAdverseExcursionAvg) <= Math.abs(perf.maxFavorableExcursionAvg) * 0.6) {
    whatWorked.push('Risk-vs-reward asymmetry favours the strategy on average.');
  }

  if (perf.stopHitRate >= 50) {
    whatFailed.push(`Stops are being hit ${perf.stopHitRate.toFixed(0)}% of the time — consider stop placement.`);
    learningTags.push('stop_too_tight');
  }
  if (perf.targetHitRate <= 20 && perf.evaluatedSignals >= 10) {
    whatFailed.push(`Targets are only being hit ${perf.targetHitRate.toFixed(0)}% of the time.`);
    learningTags.push('target_too_far');
  }
  if (perf.maxDrawdownPct <= -20) {
    whatFailed.push(`Max drawdown ${perf.maxDrawdownPct.toFixed(1)}% indicates clustered losses.`);
    learningTags.push('regime_mismatch');
  }
  if (perf.expectancy <= -0.2) {
    whatFailed.push('Negative expectancy in the evaluated window.');
    learningTags.push('false_breakout');
  }

  const calibrationNotes: string[] = [];
  if (perf.approvalAccuracy > 0 && perf.approvalAccuracy < perf.winRate - 5) {
    calibrationNotes.push('Approval-accuracy lags raw win rate — risk gate may be over-restrictive.');
    learningTags.push('high_calibration_drift');
  }

  const recommendation = toLearningRecommendation(perf.recommendation);
  const explanation = reviewExplanation(perf.healthLabel, perf.expectancy, perf.evaluatedSignals);

  return {
    strategyId:       perf.strategyId,
    strategyName:     meta.strategyName,
    reviewStatus,
    totalReviewed:    perf.evaluatedSignals,
    whatWorked,
    whatFailed,
    calibrationNotes,
    learningTags,
    recommendation,
    explanation,
  };
}

function buildConflictInsights(
  outcomes: PerformanceOutcomeRow[],
  strategies: StrategyPerformance[],
): string[] {
  const out: string[] = [];

  // Insight 1 — categories that quietly underperform on the window.
  const byCategory = new Map<string, { total: number; expSum: number; n: number }>();
  for (const s of strategies) {
    if (s.performanceStatus === 'INSUFFICIENT_DATA') continue;
    const c = byCategory.get(s.category) ?? { total: 0, expSum: 0, n: 0 };
    c.total += s.evaluatedSignals; c.expSum += s.expectancy; c.n += 1;
    byCategory.set(s.category, c);
  }
  for (const [cat, agg] of byCategory.entries()) {
    if (agg.n >= 2 && agg.total >= 10 && agg.expSum / agg.n < 0) {
      out.push(`${cat.replace(/_/g, ' ')} strategies have non-positive expectancy in the selected window.`);
    }
  }

  // Insight 2 — bullish vs bearish split.
  const bullish = outcomes.filter((o) => o.direction === 'BUY' && (o.outcome === 'WIN' || o.outcome === 'LOSS'));
  const bearish = outcomes.filter((o) => o.direction === 'SELL' && (o.outcome === 'WIN' || o.outcome === 'LOSS'));
  if (bullish.length >= 10 && bearish.length >= 10) {
    const bullWin = bullish.filter((o) => o.outcome === 'WIN').length / bullish.length;
    const bearWin = bearish.filter((o) => o.outcome === 'WIN').length / bearish.length;
    if (bearWin - bullWin > 0.15) out.push('Bearish strategies are outperforming bullish ones in the selected window — review regime alignment.');
    if (bullWin - bearWin > 0.15) out.push('Bullish strategies are outperforming bearish ones in the selected window — risk gate may be too restrictive on long-side approvals.');
  }

  return out;
}

function toLearningRecommendation(perfRec: string): LearningRecommendation {
  switch (perfRec) {
    case 'Promote':                  return 'Promote';
    case 'Keep Active':              return 'Keep Active';
    case 'Watch Carefully':          return 'Watch Carefully';
    case 'Reduce Approval Weight':   return 'Reduce Approval Weight';
    case 'Insufficient Data':        return 'Insufficient Data';
    default:                         return 'Human Review Required';
  }
}

function reviewExplanation(label: string, expectancy: number, evaluated: number): string {
  if (label === 'INSUFFICIENT_DATA') return 'Insufficient evaluated signals to rank this strategy reliably.';
  if (label === 'EXCELLENT') return `Excellent recent track record (${evaluated} signals, expectancy ${expectancy.toFixed(2)}R).`;
  if (label === 'STRONG')    return `Strong recent track record (${evaluated} signals, expectancy ${expectancy.toFixed(2)}R).`;
  if (label === 'STABLE')    return `Stable performance — keep monitoring (${evaluated} signals, expectancy ${expectancy.toFixed(2)}R).`;
  return `Weak recent track record (${evaluated} signals, expectancy ${expectancy.toFixed(2)}R). Consider reducing approval weight or human review.`;
}
