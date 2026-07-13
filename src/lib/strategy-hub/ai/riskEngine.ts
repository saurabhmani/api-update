// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — forward-looking risk assessment (Phase 7)
//
//  Scores each strategy 0–100 on forward risk using real analytics:
//  drawdown history, performance trend, confidence drift, regime
//  fit, signal quality, and live-vs-backtest divergence (overfitting
//  proxy). Every factor carries its evidence and a mitigation.
// ════════════════════════════════════════════════════════════════

import type {
  ConfidenceDistribution,
  PerformanceSummary,
  RegimeAnalytics,
} from '../analytics/types';
import { clamp, round1 } from './aiMath';
import type { AiPrediction, AiRiskAssessment, AiRiskCategory, AiRiskFactor } from './types';

export interface RiskEngineInputs {
  strategyId: string;
  summary: PerformanceSummary | null;
  prediction: AiPrediction;
  regime: RegimeAnalytics | null;
  confidence: ConfidenceDistribution | null;
  allowedRegimes: string[] | null;
  window: string;
  /** Share of outcome rows that came from backtests (0–1). */
  backtestShare: number;
}

function riskCategory(score: number): AiRiskCategory {
  if (score >= 70) return 'high';
  if (score >= 50) return 'elevated';
  if (score >= 30) return 'moderate';
  return 'low';
}

export function buildRiskAssessment(inputs: RiskEngineInputs): AiRiskAssessment {
  const { summary, prediction, regime, confidence } = inputs;
  const factors: AiRiskFactor[] = [];
  let score = 0;

  const evaluated = summary?.evaluatedSignals ?? 0;

  // ── Drawdown probability ─────────────────────────────────────
  const dd = summary?.maxDrawdownPct ?? 0;
  const expectedDd = prediction.expectedDrawdownPct ?? dd;
  let drawdownProbability: AiRiskAssessment['drawdownProbability'] = 'low';
  if (dd >= 15 || expectedDd >= 15) {
    drawdownProbability = 'high';
    score += 25;
    factors.push({
      id: 'drawdown',
      label: 'Elevated drawdown exposure',
      severity: 'critical',
      detail: `Historical max drawdown ${round1(dd)}% with projected drawdown ${round1(expectedDd)}% in the ${inputs.window} window.`,
      mitigation: 'Reduce position sizing or raise the confidence threshold to filter marginal entries.',
    });
  } else if (dd >= 8 || expectedDd >= 8) {
    drawdownProbability = 'medium';
    score += 12;
    factors.push({
      id: 'drawdown',
      label: 'Moderate drawdown exposure',
      severity: 'warning',
      detail: `Historical max drawdown ${round1(dd)}%, projected ${round1(expectedDd)}%.`,
      mitigation: 'Monitor drawdown weekly; consider tighter stops on lower-confidence signals.',
    });
  }

  // ── Performance deterioration ────────────────────────────────
  let deteriorationRisk: AiRiskAssessment['deteriorationRisk'] = 'low';
  if (prediction.trend === 'declining' && prediction.reliable) {
    deteriorationRisk = prediction.winRateSlope < -3 ? 'high' : 'medium';
    score += deteriorationRisk === 'high' ? 22 : 12;
    factors.push({
      id: 'deterioration',
      label: 'Performance deteriorating',
      severity: deteriorationRisk === 'high' ? 'critical' : 'warning',
      detail: `Win rate is trending down ${Math.abs(prediction.winRateSlope)} pts per bucket (${prediction.basis}).`,
      mitigation: 'Review recent losing trades; consider moving the strategy to Watchlist until the trend stabilises.',
    });
  } else if (prediction.trend === 'declining') {
    deteriorationRisk = 'medium';
    score += 8;
    factors.push({
      id: 'deterioration',
      label: 'Possible deterioration (limited data)',
      severity: 'warning',
      detail: `Downward win-rate trend detected but data is limited (${prediction.dataPoints} buckets).`,
      mitigation: 'Collect more evaluated outcomes before acting; re-check after the next trading week.',
    });
  }

  // ── Confidence degradation ───────────────────────────────────
  const confidenceDegradation = prediction.confidenceSlope < -1.5 && prediction.dataPoints >= 3;
  if (confidenceDegradation) {
    score += 10;
    factors.push({
      id: 'confidence',
      label: 'Confidence degradation',
      severity: 'warning',
      detail: `Average signal confidence declining ${Math.abs(prediction.confidenceSlope)} pts per bucket; current average ${confidence?.average ?? 'n/a'}.`,
      mitigation: 'Inspect the confidence engine inputs for this strategy; degraded conviction often precedes win-rate decay.',
    });
  }

  // ── Regime mismatch ──────────────────────────────────────────
  let regimeMismatchRisk = false;
  if (regime?.dataStatus === 'AVAILABLE' && regime.worstRegime && inputs.allowedRegimes?.length) {
    const worst = regime.worstRegime;
    const allowed = inputs.allowedRegimes.map((r) => r.toLowerCase());
    if (
      worst.trades >= 3
      && worst.winRate < 40
      && allowed.includes(String(worst.regime).toLowerCase())
    ) {
      regimeMismatchRisk = true;
      score += 12;
      factors.push({
        id: 'regime',
        label: 'Regime mismatch',
        severity: 'warning',
        detail: `"${worst.regime}" is an allowed regime but produced ${round1(worst.winRate)}% win rate over ${worst.trades} trades (avg return ${round1(worst.averageReturnPct)}%).`,
        mitigation: `Consider restricting the "${worst.regime}" regime via configuration overrides.`,
      });
    }
  }

  // ── Signal quality deterioration ─────────────────────────────
  const quality = summary?.signalQualityScore ?? 0;
  const approvalRate = summary?.approvalRate ?? 0;
  const signalQualityRisk = evaluated >= 5 && (quality < 40 || approvalRate < 25);
  if (signalQualityRisk) {
    score += 12;
    factors.push({
      id: 'signal-quality',
      label: 'Signal quality deterioration',
      severity: 'warning',
      detail: `Signal quality score ${round1(quality)}/100 with approval rate ${round1(approvalRate)}%.`,
      mitigation: 'Audit recently rejected signals; low approval rates suggest the strategy is misaligned with current market conditions.',
    });
  }

  // ── Overfitting indicator ────────────────────────────────────
  // High backtest share + strong metrics + thin live sample is the
  // classic overfitting signature we can detect from platform data.
  const overfittingIndicator =
    inputs.backtestShare > 0.7
    && (summary?.winRate ?? 0) > 65
    && evaluated < 30;
  if (overfittingIndicator) {
    score += 10;
    factors.push({
      id: 'overfitting',
      label: 'Possible overfitting',
      severity: 'warning',
      detail: `${Math.round(inputs.backtestShare * 100)}% of outcome data comes from backtests while only ${evaluated} live-evaluated trades exist; strong backtest metrics may not generalise.`,
      mitigation: 'Run the strategy in paper mode to accumulate live outcomes before trusting the historical edge.',
    });
  }

  // ── Data sufficiency dampener ────────────────────────────────
  if (evaluated < 5) {
    factors.push({
      id: 'data',
      label: 'Insufficient evaluation data',
      severity: 'info',
      detail: `Only ${evaluated} evaluated trades in the ${inputs.window} window — risk estimates carry wide uncertainty.`,
      mitigation: 'Treat this assessment as provisional until at least 10 evaluated outcomes exist.',
    });
    score = Math.min(score, 45);
  }

  const finalScore = Math.round(clamp(score, 0, 100));
  return {
    strategyId: inputs.strategyId,
    riskScore: finalScore,
    riskCategory: riskCategory(finalScore),
    drawdownProbability,
    deteriorationRisk,
    confidenceDegradation,
    regimeMismatchRisk,
    signalQualityRisk,
    overfittingIndicator,
    factors,
    basis: `${evaluated} evaluated trades, ${prediction.dataPoints} trend buckets, ${inputs.window} window.`,
  };
}
