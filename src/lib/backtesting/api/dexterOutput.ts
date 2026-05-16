// ════════════════════════════════════════════════════════════════
//  Dexter AI Integration Output
//
//  Structured analytics output for Dexter AI consumption.
//  Dexter uses this to:
//  - Identify weak regimes for each strategy
//  - Detect overconfident signal bands
//  - Explain why setups should be treated cautiously
//  - Generate adaptive confidence modifiers
//  - Produce natural language performance summaries
// ════════════════════════════════════════════════════════════════

import type { BacktestRunResult } from '../runner/backtestRunner';
import type { FullPerformanceReport } from '../metrics/performanceMetrics';
import type { StrategyAnalytics } from '../analytics/byStrategy';
import type { RegimeAnalytics } from '../analytics/byRegime';
import type { SectorAnalytics } from '../analytics/bySector';
import type { ConfidenceBucketAnalytics } from '../analytics/byConfidenceBucket';
import { isConfidenceMonotonic } from '../analytics/byConfidenceBucket';
import type { NewsImpactAnalytics } from '../analytics/byNewsImpact';

// ── Dexter Output Schema ───────────────────────────────────

export interface DexterOutput {
  /** Run metadata */
  meta: {
    runId: string;
    runName: string;
    dateRange: string;
    universe: string[];
    totalSignals: number;
    totalTrades: number;
    tradingDays: number;
  };

  /** Top-line verdict */
  verdict: {
    profitable: boolean;
    edgeExists: boolean;
    riskAdjustedQuality: 'excellent' | 'good' | 'acceptable' | 'poor' | 'negative';
    confidenceCalibrated: boolean;
    recommendation: string;
  };

  /** Strategy-level insights for Dexter */
  strategyInsights: DexterStrategyInsight[];

  /** Regime-level insights */
  regimeInsights: DexterRegimeInsight[];

  /** Calibration warnings (direct Dexter consumption) */
  calibrationWarnings: DexterCalibrationWarning[];

  /** Stop/target quality analysis */
  executionQuality: {
    edgeRatio: number;
    captureRatio: number;
    painRatio: number;
    target1HitRate: number;
    target2HitRate: number;
    stopHitRate: number;
    avgBarsHeld: number;
    assessment: string;
  };

  /** Sector performance ranking */
  sectorRanking: Array<{ sector: string; expectancyR: number; winRate: number; trades: number }>;

  /** News intelligence impact analysis */
  newsIntelligence: {
    buckets: NewsImpactAnalytics[];
    newsAddsValue: boolean;
    summary: string;
  } | null;

  /** Key metrics for Dexter dashboard */
  keyMetrics: Record<string, number>;
}

export interface DexterStrategyInsight {
  strategy: string;
  verdict: 'strong' | 'acceptable' | 'weak' | 'avoid';
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  sqn: number;
  edgeRatio: number;
  sampleSize: number;
  /** Natural language insight for Dexter to relay */
  insight: string;
  /** Confidence modifier suggestion */
  confidenceModifier: number;
}

export interface DexterRegimeInsight {
  regime: string;
  verdict: 'favorable' | 'neutral' | 'unfavorable';
  winRate: number;
  expectancyR: number;
  trades: number;
  dominantStrategy: string | null;
  insight: string;
}

export interface DexterCalibrationWarning {
  bucket: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  suggestedModifier: number;
}

// ── Builder ────────────────────────────────────────────────

export function buildDexterOutput(
  result: BacktestRunResult,
  report: FullPerformanceReport,
  strategyAnalytics: StrategyAnalytics[],
  regimeAnalytics: RegimeAnalytics[],
  sectorAnalytics: SectorAnalytics[],
  confidenceAnalytics: ConfidenceBucketAnalytics[],
  newsAnalytics: NewsImpactAnalytics[] = [],
): DexterOutput {
  const summary = result.summary;

  // ── Verdict ──────────────────────────────────────────────
  const profitable = (summary?.totalReturnPct ?? 0) > 0;
  const edgeExists = (report.expectancy.expectancyR) > 0;
  const sqn = report.expectancy.sqn;
  const riskAdjustedQuality: DexterOutput['verdict']['riskAdjustedQuality'] =
    sqn >= 2.5 ? 'excellent' : sqn >= 1.5 ? 'good' : sqn >= 0.5 ? 'acceptable' : sqn >= 0 ? 'poor' : 'negative';

  const monotonic = isConfidenceMonotonic(confidenceAnalytics);

  const verdict: DexterOutput['verdict'] = {
    profitable,
    edgeExists,
    riskAdjustedQuality,
    confidenceCalibrated: monotonic.monotonic && report.calibrationSummary.calibrated,
    recommendation: buildVerdict(profitable, edgeExists, riskAdjustedQuality, sqn),
  };

  // ── Strategy Insights ────────────────────────────────────
  const strategyInsights: DexterStrategyInsight[] = strategyAnalytics.map(s => {
    const v: DexterStrategyInsight['verdict'] =
      s.expectancyR >= 0.3 && s.winRate >= 0.55 ? 'strong' :
      s.expectancyR >= 0 && s.winRate >= 0.45 ? 'acceptable' :
      s.expectancyR >= -0.1 ? 'weak' : 'avoid';

    return {
      strategy: s.strategy, verdict: v,
      winRate: s.winRate, expectancyR: s.expectancyR,
      profitFactor: s.profitFactor, sqn: s.sqn,
      edgeRatio: s.edgeRatio, sampleSize: s.trades,
      insight: buildStrategyInsight(s),
      confidenceModifier: v === 'strong' ? 3 : v === 'acceptable' ? 0 : v === 'weak' ? -3 : -5,
    };
  });

  // ── Regime Insights ──────────────────────────────────────
  const regimeInsights: DexterRegimeInsight[] = regimeAnalytics.map(r => {
    const v: DexterRegimeInsight['verdict'] =
      r.expectancyR >= 0.2 ? 'favorable' : r.expectancyR >= -0.1 ? 'neutral' : 'unfavorable';

    return {
      regime: r.regime, verdict: v,
      winRate: r.winRate, expectancyR: r.expectancyR,
      trades: r.trades, dominantStrategy: r.dominantStrategy,
      insight: `${r.regime}: ${r.winRate * 100}% win rate, ${r.expectancyR}R expectancy over ${r.trades} trades.${v === 'unfavorable' ? ' Consider reducing exposure in this regime.' : ''}`,
    };
  });

  // ── Calibration Warnings ─────────────────────────────────
  const calibrationWarnings: DexterCalibrationWarning[] = [];
  for (const cal of report.calibration) {
    if (cal.sampleSize < 10 || cal.strategy !== 'all' || cal.regime !== 'all') continue;
    if (cal.calibrationState === 'overconfident') {
      calibrationWarnings.push({
        bucket: cal.bucket, severity: 'critical',
        message: `Confidence ${cal.bucket} is overconfident: expected ${(cal.expectedHitRate * 100).toFixed(0)}% hit rate but actual is ${(cal.actualHitRate * 100).toFixed(0)}%. Reduce confidence by ${Math.abs(cal.confidenceModifierSuggestion)} points.`,
        suggestedModifier: cal.confidenceModifierSuggestion,
      });
    } else if (cal.calibrationState === 'slightly_overconfident') {
      calibrationWarnings.push({
        bucket: cal.bucket, severity: 'warning',
        message: `Confidence ${cal.bucket} is slightly overconfident: actual hit rate ${(cal.actualHitRate * 100).toFixed(0)}% vs expected ${(cal.expectedHitRate * 100).toFixed(0)}%.`,
        suggestedModifier: cal.confidenceModifierSuggestion,
      });
    } else if (cal.calibrationState === 'underconfident') {
      calibrationWarnings.push({
        bucket: cal.bucket, severity: 'info',
        message: `Confidence ${cal.bucket} is underconfident: actual hit rate ${(cal.actualHitRate * 100).toFixed(0)}% exceeds expected ${(cal.expectedHitRate * 100).toFixed(0)}%. Could boost confidence by ${cal.confidenceModifierSuggestion} points.`,
        suggestedModifier: cal.confidenceModifierSuggestion,
      });
    }
  }

  if (!monotonic.monotonic) {
    calibrationWarnings.push({
      bucket: 'overall', severity: 'critical',
      message: `Confidence scores are NOT monotonic: higher confidence does not reliably produce better results. Violations: ${monotonic.violations.join('; ')}`,
      suggestedModifier: 0,
    });
  }

  // ── Execution Quality ────────────────────────────────────
  const eq = report.mfeMae;
  const to = report.tradeOutcomes;
  const eqAssessment = eq.edgeRatio >= 2.0 ? 'Excellent edge quality — signals have strong directional accuracy.'
    : eq.edgeRatio >= 1.2 ? 'Good edge quality — favorable excursion exceeds adverse.'
    : eq.edgeRatio >= 0.8 ? 'Marginal edge — MFE/MAE near parity, exits may need improvement.'
    : 'Weak edge — adverse excursion exceeds favorable. Review stop/target placement.';

  return {
    meta: {
      runId: result.runId,
      runName: result.config.name,
      dateRange: `${result.config.startDate} to ${result.config.endDate}`,
      universe: result.config.universe,
      totalSignals: summary?.totalSignalsGenerated ?? 0,
      totalTrades: result.tradeCount,
      tradingDays: summary?.tradingDays ?? 0,
    },
    verdict,
    strategyInsights,
    regimeInsights,
    calibrationWarnings,
    executionQuality: {
      edgeRatio: eq.edgeRatio, captureRatio: eq.captureRatio, painRatio: eq.painRatio,
      target1HitRate: to.targetHitRates.target1,
      target2HitRate: to.targetHitRates.target2,
      stopHitRate: to.stopHitRate,
      avgBarsHeld: to.avgBarsHeld,
      assessment: eqAssessment,
    },
    sectorRanking: sectorAnalytics.map(s => ({
      sector: s.sector, expectancyR: s.expectancyR, winRate: s.winRate, trades: s.trades,
    })),
    newsIntelligence: newsAnalytics.length > 0 ? buildNewsIntelligence(newsAnalytics) : null,
    keyMetrics: {
      winRate: summary?.winRate ?? 0,
      profitFactor: report.expectancy.profitFactor,
      expectancyR: report.expectancy.expectancyR,
      sqn: report.expectancy.sqn,
      sharpe: summary?.sharpeRatio ?? 0,
      sortino: summary?.sortinoRatio ?? 0,
      maxDrawdown: summary?.maxDrawdownPct ?? 0,
      edgeRatio: eq.edgeRatio,
      totalReturn: summary?.totalReturnPct ?? 0,
    },
  };
}

function buildVerdict(profitable: boolean, edge: boolean, quality: string, sqn: number): string {
  if (!profitable) return 'System is not profitable over the test period. Review strategy rules and filters.';
  if (!edge) return 'System shows no statistical edge. Winning trades may be due to market drift.';
  if (quality === 'excellent') return `Strong edge confirmed (SQN ${sqn}). System is production-ready with appropriate position sizing.`;
  if (quality === 'good') return `Good edge detected (SQN ${sqn}). System is viable with careful risk management.`;
  if (quality === 'acceptable') return `Marginal edge (SQN ${sqn}). System works but is sensitive to market conditions. Use with caution.`;
  return `Weak performance (SQN ${sqn}). Requires significant improvement before live deployment.`;
}

function buildNewsIntelligence(analytics: NewsImpactAnalytics[]): DexterOutput['newsIntelligence'] {
  const baseline = analytics.find(a => a.bucket === 'no_news');
  const highImpact = analytics.find(a => a.bucket === 'high_impact');

  // News adds value if high-impact trades outperform baseline
  const newsAddsValue = highImpact != null && baseline != null
    && highImpact.expectancyR > baseline.expectancyR
    && highImpact.winRate >= baseline.winRate;

  const parts: string[] = [];
  if (baseline) parts.push(`Baseline (no news): ${(baseline.winRate * 100).toFixed(0)}% win rate, ${baseline.expectancyR}R expectancy.`);
  if (highImpact) {
    if (newsAddsValue) {
      parts.push(`High-impact news trades outperform: ${(highImpact.winRate * 100).toFixed(0)}% win rate, ${highImpact.expectancyR}R expectancy. News intelligence adds value.`);
    } else {
      parts.push(`High-impact news trades: ${(highImpact.winRate * 100).toFixed(0)}% win rate, ${highImpact.expectancyR}R expectancy. News impact may need recalibration.`);
    }
  }
  if (analytics.length === 0 || (analytics.length === 1 && baseline)) {
    parts.push('Insufficient news-tagged data for impact analysis.');
  }

  return { buckets: analytics, newsAddsValue, summary: parts.join(' ') };
}

function buildStrategyInsight(s: StrategyAnalytics): string {
  const parts: string[] = [];
  parts.push(`${s.strategy}: ${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% win rate, ${s.expectancyR}R expectancy.`);
  if (s.profitFactor >= 2) parts.push('High profit factor — strong edge.');
  else if (s.profitFactor < 1) parts.push('Profit factor below 1 — losing strategy.');
  if (s.edgeRatio >= 2) parts.push('Excellent MFE/MAE ratio.');
  else if (s.edgeRatio < 1) parts.push('Poor MFE/MAE — signals lack directional accuracy.');
  if (s.target1HitRate >= 0.6) parts.push(`T1 hit rate ${(s.target1HitRate * 100).toFixed(0)}% — good entry quality.`);
  return parts.join(' ');
}
