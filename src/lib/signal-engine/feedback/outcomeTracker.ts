// ════════════════════════════════════════════════════════════════
//  Signal Outcome Tracker + Strategy Performance — Phase 4
// ════════════════════════════════════════════════════════════════

import type { SignalOutcome, OutcomeLabel, StrategyPerformanceSnapshot, EnvironmentFit, ConfidenceCalibrationSnapshot, CalibrationState, AdaptiveRecommendation, FeedbackState } from '../types/phase4.types';

// ── Evaluate outcome from post-signal candle data ───────────

export function evaluateOutcome(
  signalId: number,
  entryPrice: number,
  stopLoss: number,
  target1: number,
  target2: number,
  target3: number,
  postCandles: Array<{ high: number; low: number; close: number }>,
  isBearish = false,
): SignalOutcome {
  let maxFav = 0, maxAdv = 0;
  let t1Hit = false, t2Hit = false, t3Hit = false, stopHit = false;
  let entryTriggered = false, barsToEntry: number | null = null;

  for (let i = 0; i < postCandles.length; i++) {
    const c = postCandles[i];
    const favExcursion = isBearish ? (entryPrice - c.low) / entryPrice * 100 : (c.high - entryPrice) / entryPrice * 100;
    const advExcursion = isBearish ? (c.high - entryPrice) / entryPrice * 100 : (entryPrice - c.low) / entryPrice * 100;

    maxFav = Math.max(maxFav, favExcursion);
    maxAdv = Math.max(maxAdv, advExcursion);

    if (!entryTriggered) { entryTriggered = true; barsToEntry = i; }

    if (isBearish) {
      if (c.low <= target1) t1Hit = true;
      if (c.low <= target2) t2Hit = true;
      if (c.low <= target3) t3Hit = true;
      if (c.high >= stopLoss) stopHit = true;
    } else {
      if (c.high >= target1) t1Hit = true;
      if (c.high >= target2) t2Hit = true;
      if (c.high >= target3) t3Hit = true;
      if (c.low <= stopLoss) stopHit = true;
    }
  }

  const r5 = postCandles.length >= 5 ? Math.round(((postCandles[4].close - entryPrice) / entryPrice) * 10000) / 100 : null;
  const r10 = postCandles.length >= 10 ? Math.round(((postCandles[9].close - entryPrice) / entryPrice) * 10000) / 100 : null;

  let outcomeLabel: OutcomeLabel;
  if (stopHit && !t1Hit) outcomeLabel = 'stopped_out';
  else if (t2Hit) outcomeLabel = 'good_followthrough';
  else if (t1Hit) outcomeLabel = 'partial_success';
  else if (!entryTriggered) outcomeLabel = 'stale_no_trigger';
  else if (postCandles.length >= 10) outcomeLabel = 'expired';
  else outcomeLabel = 'ambiguous';

  // Compute pnlR (profit/loss in R-multiples).
  // 1R = initial risk (entry - stop). Stopped out = -1R.
  const risk = Math.abs(entryPrice - stopLoss);
  let pnlR = 0;
  if (risk > 0) {
    if (stopHit && !t1Hit) pnlR = -1;
    else if (t3Hit) pnlR = Math.round(Math.abs(target3 - entryPrice) / risk * 100) / 100;
    else if (t2Hit) pnlR = Math.round(Math.abs(target2 - entryPrice) / risk * 100) / 100;
    else if (t1Hit) pnlR = Math.round(Math.abs(target1 - entryPrice) / risk * 100) / 100;
    else if (r10 != null) pnlR = Math.round((r10 / 100 * entryPrice) / risk * 100) / 100;
    else if (r5 != null) pnlR = Math.round((r5 / 100 * entryPrice) / risk * 100) / 100;
  }

  return {
    signalId, entryTriggered, barsToEntry,
    target1Hit: t1Hit, target2Hit: t2Hit, target3Hit: t3Hit, stopHit,
    maxFavorableExcursionPct: Math.round(maxFav * 100) / 100,
    maxAdverseExcursionPct: Math.round(-maxAdv * 100) / 100,
    pnlR,
    returnAtBar5Pct: r5, returnAtBar10Pct: r10,
    outcomeLabel, evaluatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
}

// ── Strategy Performance Aggregation ────────────────────────

export function aggregatePerformance(
  strategyName: string,
  regime: string,
  volatilityState: string,
  outcomes: SignalOutcome[],
  sector: string | null = null,
): StrategyPerformanceSnapshot {
  const n = outcomes.length;
  if (n < 5) {
    return { strategyName, regime, volatilityState, sector, sampleSize: n, winRate: 0, target1HitRate: 0, avgPnlR: 0, avgMFE: 0, avgMAE: 0, environmentFit: 'insufficient_data' };
  }

  const wins = outcomes.filter(o => o.target1Hit).length;
  const winRate = Math.round((wins / n) * 100) / 100;
  const t1Rate = winRate;
  const avgPnlR = Math.round(outcomes.reduce((s, o) => s + o.pnlR, 0) / n * 1000) / 1000;
  const avgMFE = Math.round(outcomes.reduce((s, o) => s + o.maxFavorableExcursionPct, 0) / n * 1000) / 1000;
  const avgMAE = Math.round(outcomes.reduce((s, o) => s + o.maxAdverseExcursionPct, 0) / n * 1000) / 1000;

  let envFit: EnvironmentFit;
  if (winRate >= 0.65 && avgMFE > 0.03) envFit = 'excellent';
  else if (winRate >= 0.55) envFit = 'good';
  else if (winRate >= 0.45) envFit = 'moderate';
  else envFit = 'poor';

  return { strategyName, regime, volatilityState, sector, sampleSize: n, winRate, target1HitRate: t1Rate, avgPnlR, avgMFE, avgMAE, environmentFit: envFit };
}

// ── Confidence Calibration ──────────────────────────────────

export function calibrateConfidence(
  bucket: string,
  outcomes: SignalOutcome[],
): ConfidenceCalibrationSnapshot {
  const n = outcomes.length;
  if (n < 10) return { bucket, sampleSize: n, target1HitRate: 0, avgMFE: 0, calibrationState: 'insufficient_data' };

  const t1Rate = Math.round(outcomes.filter(o => o.target1Hit).length / n * 100) / 100;
  const avgMFE = Math.round(outcomes.reduce((s, o) => s + o.maxFavorableExcursionPct, 0) / n * 1000) / 1000;

  // Expected hit rates by bucket
  const expected: Record<string, number> = { '85_100': 0.72, '70_84': 0.60, '55_69': 0.48, '0_54': 0.30 };
  const exp = expected[bucket] ?? 0.50;

  let calibrationState: CalibrationState;
  if (Math.abs(t1Rate - exp) < 0.08) calibrationState = 'well_calibrated';
  else if (t1Rate < exp - 0.15) calibrationState = 'overconfident';
  else if (t1Rate < exp - 0.08) calibrationState = 'slightly_overconfident';
  else if (t1Rate > exp + 0.08) calibrationState = 'underconfident';
  else calibrationState = 'well_calibrated';

  return { bucket, sampleSize: n, target1HitRate: t1Rate, avgMFE, calibrationState };
}

// ── Adaptive Recommendation ─────────────────────────────────

export function computeAdaptiveRecommendation(
  perf: StrategyPerformanceSnapshot,
): AdaptiveRecommendation {
  if (perf.sampleSize < 20) {
    return { strategyEnvironmentFit: 'insufficient_data', recommendedConfidenceModifier: 0, reason: 'Insufficient sample for recommendation', sampleSize: perf.sampleSize, evidenceStrength: 'weak' };
  }

  let modifier = 0;
  if (perf.environmentFit === 'excellent') modifier = 5;
  else if (perf.environmentFit === 'good') modifier = 2;
  else if (perf.environmentFit === 'poor') modifier = -5;

  const strength = perf.sampleSize >= 50 ? 'strong' as const : perf.sampleSize >= 30 ? 'moderate' as const : 'weak' as const;
  const reason = `${perf.strategyName} in ${perf.regime}: win rate ${(perf.winRate * 100).toFixed(0)}% over ${perf.sampleSize} signals (${strength} evidence)`;

  return { strategyEnvironmentFit: perf.environmentFit, recommendedConfidenceModifier: modifier, reason, sampleSize: perf.sampleSize, evidenceStrength: strength };
}

// ── Default Feedback State ──────────────────────────────────

export function defaultFeedbackState(): FeedbackState {
  return { strategyRecentWinRate: null, strategyEnvironmentFit: 'insufficient_data', confidenceCalibrationState: 'insufficient_data' };
}
