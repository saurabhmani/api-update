// ════════════════════════════════════════════════════════════════
//  Signal Outcome Tracker + Strategy Performance — Phase 4
// ════════════════════════════════════════════════════════════════

import type { SignalOutcome, OutcomeLabel, StrategyPerformanceSnapshot, EnvironmentFit, ConfidenceCalibrationSnapshot, CalibrationState, AdaptiveRecommendation, FeedbackState } from '../types/phase4.types';

export const OUTCOME_INTELLIGENCE_VERSION = '3.0.0';

export interface OutcomeEvaluationOptions {
  /** Persisted expected R:R from the signal. Defaults to target1 geometry. */
  expectedRewardRisk?: number;
  /** Stable evaluation timestamp for historical replay. */
  evaluatedAt?: string;
  metadataVersion?: string;
}

// ── Evaluate outcome from post-signal candle data ───────────

export function evaluateOutcome(
  signalId: number,
  entryPrice: number,
  stopLoss: number,
  target1: number,
  target2: number,
  target3: number,
  postCandles: Array<{ high: number; low: number; close: number; ts?: string | Date }>,
  isBearish = false,
  options: OutcomeEvaluationOptions = {},
): SignalOutcome {
  let maxFav = 0, maxAdv = 0;
  let t1Hit = false, t2Hit = false, t3Hit = false, stopHit = false;
  let entryTriggered = false, barsToEntry: number | null = null;
  let firstTargetBar: number | null = null;
  let firstTarget2Bar: number | null = null;
  let firstTarget3Bar: number | null = null;
  let firstStopBar: number | null = null;

  for (let i = 0; i < postCandles.length; i++) {
    const c = postCandles[i];
    const favExcursion = isBearish ? (entryPrice - c.low) / entryPrice * 100 : (c.high - entryPrice) / entryPrice * 100;
    const advExcursion = isBearish ? (c.high - entryPrice) / entryPrice * 100 : (entryPrice - c.low) / entryPrice * 100;

    maxFav = Math.max(maxFav, favExcursion);
    maxAdv = Math.max(maxAdv, advExcursion);

    if (!entryTriggered) { entryTriggered = true; barsToEntry = i; }

    if (isBearish) {
      if (c.low <= target1) {
        t1Hit = true;
        if (firstTargetBar == null) firstTargetBar = i;
      }
      if (c.low <= target2) {
        t2Hit = true;
        if (firstTarget2Bar == null) firstTarget2Bar = i;
      }
      if (c.low <= target3) {
        t3Hit = true;
        if (firstTarget3Bar == null) firstTarget3Bar = i;
      }
      if (c.high >= stopLoss) {
        stopHit = true;
        if (firstStopBar == null) firstStopBar = i;
      }
    } else {
      if (c.high >= target1) {
        t1Hit = true;
        if (firstTargetBar == null) firstTargetBar = i;
      }
      if (c.high >= target2) {
        t2Hit = true;
        if (firstTarget2Bar == null) firstTarget2Bar = i;
      }
      if (c.high >= target3) {
        t3Hit = true;
        if (firstTarget3Bar == null) firstTarget3Bar = i;
      }
      if (c.low <= stopLoss) {
        stopHit = true;
        if (firstStopBar == null) firstStopBar = i;
      }
    }
  }

  const direction = isBearish ? -1 : 1;
  const r5 = postCandles.length >= 5 ? Math.round((direction * (postCandles[4].close - entryPrice) / entryPrice) * 10000) / 100 : null;
  const r10 = postCandles.length >= 10 ? Math.round((direction * (postCandles[9].close - entryPrice) / entryPrice) * 10000) / 100 : null;

  const stopBeforeTarget = firstStopBar != null
    && (firstTargetBar == null || firstStopBar <= firstTargetBar);
  const target3BeforeStop = firstTarget3Bar != null
    && (firstStopBar == null || firstTarget3Bar < firstStopBar);
  const target2BeforeStop = firstTarget2Bar != null
    && (firstStopBar == null || firstTarget2Bar < firstStopBar);
  const target1BeforeStop = firstTargetBar != null
    && (firstStopBar == null || firstTargetBar < firstStopBar);

  let outcomeLabel: OutcomeLabel;
  if (stopBeforeTarget) outcomeLabel = 'stopped_out';
  else if (t2Hit && target2BeforeStop) outcomeLabel = 'good_followthrough';
  else if (t1Hit && target1BeforeStop) outcomeLabel = 'partial_success';
  else if (!entryTriggered) outcomeLabel = 'stale_no_trigger';
  else if (postCandles.length >= 10) outcomeLabel = 'expired';
  else outcomeLabel = 'ambiguous';

  // Compute pnlR (profit/loss in R-multiples).
  // 1R = initial risk (entry - stop). Stopped out = -1R.
  const risk = Math.abs(entryPrice - stopLoss);
  let pnlR = 0;
  if (risk > 0) {
    if (stopBeforeTarget) pnlR = -1;
    else if (t3Hit && target3BeforeStop) pnlR = Math.round(Math.abs(target3 - entryPrice) / risk * 100) / 100;
    else if (t2Hit && target2BeforeStop) pnlR = Math.round(Math.abs(target2 - entryPrice) / risk * 100) / 100;
    else if (t1Hit && target1BeforeStop) pnlR = Math.round(Math.abs(target1 - entryPrice) / risk * 100) / 100;
    else if (r10 != null) pnlR = Math.round((r10 / 100 * entryPrice) / risk * 100) / 100;
    else if (r5 != null) pnlR = Math.round((r5 / 100 * entryPrice) / risk * 100) / 100;
  }

  const riskPct = entryPrice > 0 ? risk / entryPrice * 100 : 0;
  const expectedRewardRisk = options.expectedRewardRisk
    ?? (risk > 0 ? Math.abs(target1 - entryPrice) / risk : 0);
  const realizedReturnPct = Math.round(pnlR * riskPct * 100) / 100;
  const realizedRewardRisk = Math.round(pnlR * 100) / 100;
  const adverseRiskUnits = riskPct > 0 ? maxAdv / riskPct : 1;
  const entryQualityScore = Math.max(0, Math.min(100, Math.round(100 - adverseRiskUnits * 50)));

  const exitReason: NonNullable<SignalOutcome['exitReason']> =
    !entryTriggered ? 'not_triggered'
      : stopBeforeTarget ? 'stop'
        : t3Hit && target3BeforeStop ? 'target3'
          : t2Hit && target2BeforeStop ? 'target2'
            : t1Hit && target1BeforeStop ? 'target1'
              : 'horizon_close';
  const exitBar = exitReason === 'stop'
    ? firstStopBar
    : exitReason === 'target3'
      ? firstTarget3Bar
      : exitReason === 'target2'
        ? firstTarget2Bar
        : exitReason === 'target1'
          ? firstTargetBar
      : postCandles.length > 0
        ? postCandles.length - 1
        : null;
  const lastCandleTs = postCandles.at(-1)?.ts;
  const stableEvaluatedAt = options.evaluatedAt
    ?? (lastCandleTs instanceof Date ? lastCandleTs.toISOString() : lastCandleTs)
    ?? new Date().toISOString();

  return {
    signalId, entryTriggered, barsToEntry,
    target1Hit: t1Hit, target2Hit: t2Hit, target3Hit: t3Hit, stopHit,
    maxFavorableExcursionPct: Math.round(maxFav * 100) / 100,
    maxAdverseExcursionPct: Math.round(-maxAdv * 100) / 100,
    pnlR,
    returnAtBar5Pct: r5, returnAtBar10Pct: r10,
    outcomeLabel,
    evaluatedAt: String(stableEvaluatedAt).slice(0, 19).replace('T', ' '),
    outcomeVersion: OUTCOME_INTELLIGENCE_VERSION,
    entryQualityScore,
    timeToTargetBars: firstTargetBar,
    timeToStopBars: firstStopBar,
    holdingDurationBars: exitBar == null ? 0 : exitBar + 1,
    exitReason,
    realizedReturnPct,
    riskAdjustedReturn: realizedRewardRisk,
    expectedRewardRisk: Math.round(expectedRewardRisk * 100) / 100,
    realizedRewardRisk,
    metadataVersion: options.metadataVersion ?? OUTCOME_INTELLIGENCE_VERSION,
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
