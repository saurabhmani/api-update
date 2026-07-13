// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — predictive performance engine (Phase 7)
//
//  Projects near-term strategy health by fitting linear trends over
//  the Phase-5 trend buckets (real evaluated outcomes only). All
//  projections are clamped to sane bounds and flagged unreliable
//  when the sample is too small.
// ════════════════════════════════════════════════════════════════

import type { TrendAnalytics } from '../analytics/types';
import type { PerformanceSummary } from '../analytics/types';
import { clamp, linearTrend, round1, round2 } from './aiMath';
import type { AiPrediction } from './types';

const MIN_POINTS_RELIABLE = 3;
const MIN_TRADES_RELIABLE = 10;

export function buildAiPrediction(
  strategyId: string,
  trends: TrendAnalytics | null,
  summary: PerformanceSummary | null,
  window: string,
): AiPrediction {
  const points = (trends?.points ?? []).filter((p) => p.trades > 0);
  const totalTrades = points.reduce((a, p) => a + p.trades, 0);
  const reliable = points.length >= MIN_POINTS_RELIABLE && totalTrades >= MIN_TRADES_RELIABLE;

  if (points.length === 0) {
    return {
      strategyId,
      trend: 'stable',
      expectedWinRate: summary?.winRate ?? null,
      expectedDrawdownPct: summary?.maxDrawdownPct ?? null,
      expectedProfitFactor: summary?.profitFactor ?? null,
      expectedSharpe: summary?.sharpeRatio ?? null,
      expectedConfidence: summary?.averageConfidence ?? null,
      winRateSlope: 0,
      returnSlope: 0,
      confidenceSlope: 0,
      basis: `No evaluated trend buckets in the ${window} window — projection falls back to current metrics.`,
      dataPoints: 0,
      reliable: false,
    };
  }

  const winRates = points.map((p) => p.winRate);
  const returns = points.map((p) => p.returnPct);
  const drawdowns = points.map((p) => p.drawdownPct);
  const confidences = points
    .map((p) => p.averageConfidence)
    .filter((c): c is number => c != null);

  const wr = linearTrend(winRates);
  const ret = linearTrend(returns);
  const dd = linearTrend(drawdowns);
  const conf = linearTrend(confidences);

  // Blend projection with current level so a single hot bucket cannot
  // dominate — the projection weight grows with data volume.
  const projWeight = clamp(points.length / 8, 0.25, 0.6);
  const currentWinRate = summary?.winRate ?? winRates[winRates.length - 1];
  const expectedWinRate = clamp(
    currentWinRate * (1 - projWeight) + wr.next * projWeight,
    0,
    100,
  );

  const currentPf = summary?.profitFactor ?? 0;
  // Profit factor is not projected directly (unstable ratio); shift it
  // proportionally with the projected return trend instead.
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const returnShift = avgReturn !== 0 ? (ret.next - avgReturn) / Math.abs(avgReturn) : 0;
  const expectedProfitFactor = currentPf > 0
    ? clamp(currentPf * (1 + clamp(returnShift, -0.5, 0.5) * projWeight), 0, 99)
    : currentPf;

  const expectedDrawdown = clamp(
    (summary?.maxDrawdownPct ?? drawdowns[drawdowns.length - 1]) * (1 - projWeight)
      + Math.max(0, dd.next) * projWeight,
    0,
    100,
  );

  const expectedConfidence = confidences.length
    ? clamp(conf.next, 0, 100)
    : summary?.averageConfidence ?? null;

  // Trend classification: win-rate slope drives the label; the return
  // slope acts as a tie-breaker for weak signals.
  const slope = wr.slope;
  let trend: AiPrediction['trend'] = 'stable';
  if (slope > 1.5 || (slope > 0.5 && ret.slope > 0)) trend = 'improving';
  else if (slope < -1.5 || (slope < -0.5 && ret.slope < 0)) trend = 'declining';

  return {
    strategyId,
    trend,
    expectedWinRate: round1(expectedWinRate),
    expectedDrawdownPct: round2(expectedDrawdown),
    expectedProfitFactor: round2(expectedProfitFactor),
    expectedSharpe: summary?.sharpeRatio ?? null,
    expectedConfidence: expectedConfidence != null ? round1(expectedConfidence) : null,
    winRateSlope: round2(slope),
    returnSlope: round2(ret.slope),
    confidenceSlope: round2(conf.slope),
    basis: `Linear trend over ${points.length} ${trends?.granularity ?? 'weekly'} buckets `
      + `(${totalTrades} evaluated trades, ${window} window, R²=${round2(wr.r2)}).`,
    dataPoints: points.length,
    reliable,
  };
}
