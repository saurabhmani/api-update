// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — strategy advisor (Phase 7)
//
//  Generates explainable, evidence-backed recommendations. Every
//  recommendation is derived from real outcome rows / analytics and
//  quantifies its expected impact by re-computing metrics on the
//  matching historical subset (same mechanics as the simulator).
//  Nothing here mutates configuration — recommendations are advisory
//  until an administrator explicitly applies them.
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import type {
  ConfidenceDistribution,
  LearningInsights,
  PerformanceSummary,
  RegimeAnalytics,
} from '../analytics/types';
import { computeSimulationMetrics, round1 } from './aiMath';
import type {
  AiAnomaly,
  AiConfidenceLevel,
  AiPrediction,
  AiRecommendation,
  AiRiskAssessment,
} from './types';

export interface AdvisorInputs {
  strategyId: string;
  strategyName: string;
  window: string;
  rows: PerformanceOutcomeRow[];
  summary: PerformanceSummary | null;
  regime: RegimeAnalytics | null;
  confidence: ConfidenceDistribution | null;
  learning: LearningInsights | null;
  prediction: AiPrediction;
  risk: AiRiskAssessment;
  anomalies: AiAnomaly[];
  currentMode: string;
  deploymentStatus: string;
  paperTradingEnabled: boolean;
  latestValidation: { status: string; score: number; target: string; at: string } | null;
  allowedRegimes: string[] | null;
  riskProfile: string | null;
}

function evidenceConfidence(trades: number, delta: number): AiConfidenceLevel {
  if (trades >= 25 && Math.abs(delta) >= 8) return 'high';
  if (trades >= 10 && Math.abs(delta) >= 4) return 'medium';
  return 'low';
}

export function buildAiRecommendations(inputs: AdvisorInputs): AiRecommendation[] {
  const recs: AiRecommendation[] = [];
  const { strategyId, strategyName, window, rows, summary } = inputs;
  const evaluated = summary?.evaluatedSignals ?? 0;
  const basis = `${window} window, ${evaluated} evaluated trades (direct + observed outcomes)`;

  const push = (rec: Omit<AiRecommendation, 'strategyId' | 'strategyName' | 'historicalBasis'>) =>
    recs.push({ ...rec, strategyId, strategyName, historicalBasis: basis });

  // ── 1. Confidence threshold tuning ───────────────────────────
  // Compare full history vs the subset above a candidate threshold.
  const confidences = rows
    .map((r) => r.confidenceScore)
    .filter((c): c is number => c != null)
    .sort((a, b) => a - b);
  if (confidences.length >= 10) {
    const median = confidences[Math.floor(confidences.length / 2)];
    const candidate = Math.round(median / 5) * 5;
    const baseline = computeSimulationMetrics(rows);
    const filtered = computeSimulationMetrics(
      rows.filter((r) => (r.confidenceScore ?? 0) >= candidate),
    );
    const wrGain = filtered.winRate - baseline.winRate;
    if (filtered.trades >= 5 && wrGain >= 5 && filtered.profitFactor >= baseline.profitFactor) {
      push({
        key: `${strategyId}:raise-confidence-threshold`,
        category: 'threshold',
        action: `Raise the minimum confidence threshold to ~${candidate}`,
        reason: `Signals at or above confidence ${candidate} materially outperform the full sample.`,
        evidence: [
          `Full sample: ${baseline.trades} trades, ${baseline.winRate}% win rate, PF ${baseline.profitFactor}.`,
          `Confidence ≥ ${candidate}: ${filtered.trades} trades, ${filtered.winRate}% win rate, PF ${filtered.profitFactor}.`,
          `Win-rate improvement: +${round1(wrGain)} pts; drawdown ${filtered.maxDrawdownPct}% vs ${baseline.maxDrawdownPct}%.`,
        ],
        expectedImpact: `≈ +${round1(wrGain)} pts win rate at the cost of ${baseline.trades - filtered.trades} fewer historical trades.`,
        confidenceLevel: evidenceConfidence(filtered.trades, wrGain),
        applyMode: 'manual_config',
      });
    } else if (filtered.trades >= 5 && wrGain <= -5) {
      push({
        key: `${strategyId}:lower-confidence-threshold`,
        category: 'threshold',
        action: 'Do not tighten the confidence filter further',
        reason: `High-confidence signals are currently underperforming the full sample — tightening would remove the wrong trades.`,
        evidence: [
          `Full sample: ${baseline.winRate}% win rate over ${baseline.trades} trades.`,
          `Confidence ≥ ${candidate}: ${filtered.winRate}% win rate over ${filtered.trades} trades.`,
        ],
        expectedImpact: 'Avoids removing profitable lower-confidence trades; investigate confidence calibration instead.',
        confidenceLevel: evidenceConfidence(filtered.trades, wrGain),
        applyMode: 'advisory',
      });
    }
  }

  // ── 2. Regime restriction ────────────────────────────────────
  const worst = inputs.regime?.worstRegime;
  if (
    inputs.regime?.dataStatus === 'AVAILABLE'
    && worst
    && worst.trades >= 4
    && worst.winRate < 40
  ) {
    const baseline = computeSimulationMetrics(rows);
    const without = computeSimulationMetrics(
      rows.filter((r) => String(r.regime ?? '') !== worst.regime),
    );
    const wrGain = without.winRate - baseline.winRate;
    if (wrGain > 2 && without.trades >= 5) {
      push({
        key: `${strategyId}:restrict-regime-${worst.regime.replace(/\s+/g, '-').toLowerCase()}`,
        category: 'regime',
        action: `Restrict the "${worst.regime}" market regime`,
        reason: `This regime accounts for the weakest cohort of trades in the ${window} window.`,
        evidence: [
          `"${worst.regime}": ${worst.trades} trades, ${round1(worst.winRate)}% win rate, avg return ${round1(worst.averageReturnPct)}%.`,
          `Excluding it: win rate ${without.winRate}% vs ${baseline.winRate}% overall (PF ${without.profitFactor} vs ${baseline.profitFactor}).`,
          ...(inputs.regime.bestRegime
            ? [`Best regime remains "${inputs.regime.bestRegime.regime}" at ${round1(inputs.regime.bestRegime.winRate)}% win rate.`]
            : []),
        ],
        expectedImpact: `≈ +${round1(wrGain)} pts win rate and drawdown ${without.maxDrawdownPct}% vs ${baseline.maxDrawdownPct}%.`,
        confidenceLevel: evidenceConfidence(worst.trades, wrGain),
        applyMode: 'manual_config',
      });
    }
  }

  // ── 3. Mode recommendations (executable) ─────────────────────
  const winRate = summary?.winRate ?? 0;
  const health = summary?.healthLabel ?? 'INSUFFICIENT_DATA';
  const declining = inputs.prediction.trend === 'declining' && inputs.prediction.reliable;
  const criticalAnomalies = inputs.anomalies.filter((a) => a.severity === 'critical');

  if (evaluated >= 10 && winRate < 35 && inputs.risk.riskCategory === 'high'
      && inputs.currentMode !== 'DISABLED') {
    push({
      key: `${strategyId}:disable`,
      category: 'mode',
      action: 'Disable this strategy',
      reason: 'Sustained losses combined with a high forward-risk score — continuing to trade it is expected to be value-destructive.',
      evidence: [
        `Win rate ${round1(winRate)}% over ${evaluated} evaluated trades.`,
        `AI risk score ${inputs.risk.riskScore}/100 (${inputs.risk.riskCategory}).`,
        ...criticalAnomalies.map((a) => `Critical anomaly: ${a.title}.`),
      ],
      expectedImpact: 'Stops new signal generation; existing analysis and history are preserved.',
      confidenceLevel: 'high',
      applyMode: 'mode_change',
      targetMode: 'DISABLED',
    });
  } else if (
    evaluated >= 8
    && (declining || criticalAnomalies.length > 0)
    && winRate < 48
    && inputs.currentMode === 'CONFIRMED_ENABLED'
  ) {
    push({
      key: `${strategyId}:watchlist`,
      category: 'mode',
      action: 'Move this strategy to Watchlist',
      reason: declining
        ? 'Performance is on a reliable downward trend — watchlisting keeps signals visible without acting on them.'
        : 'Critical anomalies were detected — watchlisting pauses execution while the behaviour is investigated.',
      evidence: [
        `Win rate ${round1(winRate)}% (trend: ${inputs.prediction.trend}, slope ${inputs.prediction.winRateSlope} pts/bucket).`,
        `Risk score ${inputs.risk.riskScore}/100.`,
        ...criticalAnomalies.map((a) => `Anomaly: ${a.title} — ${a.rootCause}`),
      ],
      expectedImpact: 'Signals continue to be generated and tracked, but marked watchlist-only.',
      confidenceLevel: declining ? 'high' : 'medium',
      applyMode: 'mode_change',
      targetMode: 'WATCHLIST_ONLY',
    });
  } else if (
    evaluated >= 15
    && winRate >= 55
    && (health === 'EXCELLENT' || health === 'STRONG')
    && inputs.prediction.trend !== 'declining'
    && inputs.risk.riskCategory === 'low'
    && inputs.currentMode !== 'CONFIRMED_ENABLED'
  ) {
    push({
      key: `${strategyId}:enable`,
      category: 'mode',
      action: 'Re-enable this strategy (Confirmed mode)',
      reason: 'The strategy shows strong, stable performance with low forward risk while not fully enabled.',
      evidence: [
        `Win rate ${round1(winRate)}% over ${evaluated} trades, health ${health}.`,
        `Prediction: ${inputs.prediction.trend} (expected win rate ${inputs.prediction.expectedWinRate}%).`,
        `Risk score ${inputs.risk.riskScore}/100 (low).`,
      ],
      expectedImpact: 'Restores full signal generation and confirmation for this strategy.',
      confidenceLevel: 'medium',
      applyMode: 'mode_change',
      targetMode: 'CONFIRMED_ENABLED',
    });
  }

  // ── 4. Deployment recommendations ────────────────────────────
  const validationReady = inputs.latestValidation?.status === 'ready';
  if (
    evaluated >= 15
    && winRate >= 52
    && (health === 'EXCELLENT' || health === 'STRONG' || health === 'STABLE')
    && inputs.risk.riskCategory !== 'high'
    && !inputs.paperTradingEnabled
    && inputs.currentMode === 'CONFIRMED_ENABLED'
  ) {
    push({
      key: `${strategyId}:paper-deploy`,
      category: 'deployment',
      action: 'Deploy this strategy to paper trading',
      reason: 'Consistent live-signal performance with acceptable risk — paper trading would validate execution without capital risk.',
      evidence: [
        `Win rate ${round1(winRate)}%, profit factor ${summary?.profitFactor ?? 0}, drawdown ${summary?.maxDrawdownPct ?? 0}%.`,
        inputs.latestValidation
          ? `Latest validation: ${inputs.latestValidation.status} (score ${inputs.latestValidation.score}, ${inputs.latestValidation.target}).`
          : 'No validation run yet — run one before deploying.',
        `Forward risk: ${inputs.risk.riskCategory} (${inputs.risk.riskScore}/100).`,
      ],
      expectedImpact: 'Builds an execution track record for a future live-deployment decision.',
      confidenceLevel: validationReady ? 'high' : 'medium',
      applyMode: 'manual_deploy',
    });
  }

  // ── 5. Risk-profile advisory ─────────────────────────────────
  const dd = summary?.maxDrawdownPct ?? 0;
  if (evaluated >= 10 && dd >= 12 && (inputs.riskProfile === 'moderate' || inputs.riskProfile === 'low')) {
    push({
      key: `${strategyId}:risk-profile-mismatch`,
      category: 'risk',
      action: `Review the "${inputs.riskProfile}" risk profile classification`,
      reason: 'Realised drawdown is inconsistent with the configured risk profile — sizing decisions built on it may understate risk.',
      evidence: [
        `Max drawdown ${round1(dd)}% in the ${window} window with expected drawdown ${inputs.prediction.expectedDrawdownPct}%.`,
        `Configured risk profile: ${inputs.riskProfile}.`,
      ],
      expectedImpact: 'More accurate position sizing and portfolio risk budgeting.',
      confidenceLevel: 'medium',
      applyMode: 'advisory',
    });
  }

  // ── 6. Parameter recommendations from the Learning Engine ────
  for (const lr of inputs.learning?.recommendations ?? []) {
    if (lr.category !== 'parameter' && lr.category !== 'confidence') continue;
    push({
      key: `${strategyId}:learning-${lr.id}`,
      category: 'parameter',
      action: lr.action,
      reason: lr.reason,
      evidence: lr.evidence,
      expectedImpact: lr.expectedImpact,
      confidenceLevel: lr.confidenceLevel,
      applyMode: 'manual_config',
    });
  }

  return recs;
}
