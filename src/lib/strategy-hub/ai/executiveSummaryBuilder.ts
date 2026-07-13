// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — executive summary builder (Phase 7)
//
//  Condenses per-strategy AI insights into a hub-level narrative for
//  daily / weekly / monthly review. Purely derived from the supplied
//  insight snapshots — every line traces back to real metrics.
// ════════════════════════════════════════════════════════════════

import { round1 } from './aiMath';
import type {
  AiAnomaly,
  AiPrediction,
  AiRecommendation,
  AiRiskAssessment,
  ExecutiveSummary,
  SummaryPeriod,
} from './types';

export interface StrategyInsightSnapshot {
  strategyId: string;
  strategyName: string;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  evaluatedSignals: number;
  healthLabel: string;
  prediction: AiPrediction;
  risk: AiRiskAssessment;
  recommendations: AiRecommendation[];
  anomalies: AiAnomaly[];
  validationStatus: string | null;
}

export interface ExecutiveSummaryContext {
  period: SummaryPeriod;
  window: string;
  openAlerts: number;
}

export function buildExecutiveSummary(
  snapshots: StrategyInsightSnapshot[],
  ctx: ExecutiveSummaryContext,
): ExecutiveSummary {
  const withData = snapshots.filter((s) => s.evaluatedSignals >= 3);
  const evaluatedTrades = snapshots.reduce((a, s) => a + s.evaluatedSignals, 0);

  const byScore = [...withData].sort((a, b) => {
    const scoreA = a.winRate * 0.5 + a.profitFactor * 10 - a.maxDrawdownPct;
    const scoreB = b.winRate * 0.5 + b.profitFactor * 10 - b.maxDrawdownPct;
    return scoreB - scoreA;
  });

  const bestPerformers = byScore
    .filter((s) => s.winRate >= 50 && s.profitFactor >= 1.2)
    .slice(0, 3)
    .map((s) => ({
      strategyId: s.strategyId,
      strategyName: s.strategyName,
      note: `${round1(s.winRate)}% win rate, PF ${s.profitFactor}, ${s.evaluatedSignals} trades (${s.prediction.trend}).`,
    }));

  const needsAttention = withData
    .filter((s) =>
      s.risk.riskCategory === 'high'
      || s.risk.riskCategory === 'elevated'
      || (s.prediction.trend === 'declining' && s.prediction.reliable)
      || s.anomalies.some((a) => a.severity === 'critical'))
    .sort((a, b) => b.risk.riskScore - a.risk.riskScore)
    .slice(0, 5)
    .map((s) => {
      const reasons: string[] = [];
      if (s.risk.riskCategory === 'high' || s.risk.riskCategory === 'elevated') {
        reasons.push(`risk ${s.risk.riskScore}/100`);
      }
      if (s.prediction.trend === 'declining') reasons.push('declining trend');
      const critical = s.anomalies.filter((a) => a.severity === 'critical');
      if (critical.length) reasons.push(`${critical.length} critical anomal${critical.length > 1 ? 'ies' : 'y'}`);
      return {
        strategyId: s.strategyId,
        strategyName: s.strategyName,
        note: `${round1(s.winRate)}% win rate — ${reasons.join(', ')}.`,
      };
    });

  const deploymentRecommendations = snapshots
    .flatMap((s) => s.recommendations.filter((r) => r.category === 'deployment'))
    .slice(0, 5)
    .map((r) => `${r.strategyName}: ${r.action} — ${r.expectedImpact}`);

  const modeRecommendations = snapshots
    .flatMap((s) => s.recommendations.filter((r) => r.category === 'mode'))
    .slice(0, 5)
    .map((r) => `${r.strategyName}: ${r.action}`);

  const validationConcerns = snapshots
    .filter((s) => s.validationStatus === 'failed' || s.validationStatus === 'warning')
    .slice(0, 5)
    .map((s) => `${s.strategyName}: last validation ${s.validationStatus}.`);

  const highRisk = withData.filter((s) => s.risk.riskCategory === 'high');
  const elevatedRisk = withData.filter((s) => s.risk.riskCategory === 'elevated');
  const anomalyCount = snapshots.reduce((a, s) => a + s.anomalies.length, 0);
  const riskSummary: string[] = [];
  if (highRisk.length) {
    riskSummary.push(`${highRisk.length} strategies carry HIGH forward risk: ${highRisk.map((s) => s.strategyName).join(', ')}.`);
  }
  if (elevatedRisk.length) {
    riskSummary.push(`${elevatedRisk.length} strategies at elevated risk: ${elevatedRisk.map((s) => s.strategyName).join(', ')}.`);
  }
  if (anomalyCount) {
    riskSummary.push(`${anomalyCount} behavioural anomalies detected across the hub in this window.`);
  }
  if (!riskSummary.length) {
    riskSummary.push('No strategies currently exceed the elevated-risk threshold.');
  }

  const improving = withData.filter((s) => s.prediction.trend === 'improving');
  const performanceHighlights: string[] = [];
  if (byScore[0]) {
    performanceHighlights.push(
      `Top performer: ${byScore[0].strategyName} (${round1(byScore[0].winRate)}% win rate, PF ${byScore[0].profitFactor}).`,
    );
  }
  if (improving.length) {
    performanceHighlights.push(`${improving.length} strategies show an improving trend: ${improving.map((s) => s.strategyName).join(', ')}.`);
  }
  const avgWinRate = withData.length
    ? withData.reduce((a, s) => a + s.winRate, 0) / withData.length
    : 0;
  if (withData.length) {
    performanceHighlights.push(`Hub average win rate: ${round1(avgWinRate)}% across ${withData.length} strategies with data.`);
  }

  const optimizationOpportunities = snapshots
    .flatMap((s) => s.recommendations.filter((r) =>
      r.category === 'threshold' || r.category === 'regime' || r.category === 'parameter'))
    .slice(0, 6)
    .map((r) => `${r.strategyName}: ${r.action} (${r.confidenceLevel} confidence).`);

  const failedValidations = snapshots.filter((s) => s.validationStatus === 'failed').length;

  const headline = withData.length === 0
    ? `Insufficient evaluated data in the ${ctx.window} window to generate a meaningful ${ctx.period} summary.`
    : `${ctx.period[0].toUpperCase()}${ctx.period.slice(1)} review: ${withData.length} strategies analyzed over ${ctx.window}; `
      + `${bestPerformers.length} performing well, ${needsAttention.length} need attention, `
      + `${highRisk.length} at high risk, ${anomalyCount} anomalies detected.`;

  return {
    generatedAt: new Date().toISOString(),
    period: ctx.period,
    window: ctx.window,
    headline,
    bestPerformers,
    needsAttention,
    deploymentRecommendations: [...deploymentRecommendations, ...modeRecommendations].slice(0, 6),
    validationConcerns,
    riskSummary,
    performanceHighlights,
    optimizationOpportunities,
    totals: {
      strategiesAnalyzed: snapshots.length,
      evaluatedTrades,
      openAlerts: ctx.openAlerts,
      failedValidations,
    },
  };
}
