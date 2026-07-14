// ════════════════════════════════════════════════════════════════
//  Signal Outcome Tracker + Strategy Performance — Phase 4
// ════════════════════════════════════════════════════════════════

import type { SignalOutcome, OutcomeLabel, StrategyPerformanceSnapshot, EnvironmentFit, ConfidenceCalibrationSnapshot, CalibrationState, AdaptiveRecommendation, FeedbackState } from '../types/phase4.types';
import {
  computeEmpiricalBucketMetrics,
  CALIBRATION_HIT_RATE_PRIORS,
  CONFIDENCE_MODEL_VERSION,
  type EmpiricalOutcomeRow,
} from '../scoring/empiricalCalibration';

export const OUTCOME_INTELLIGENCE_VERSION = '8.0.0';

export interface OutcomeEvaluationOptions {
  /** Persisted expected R:R from the signal. Defaults to target1 geometry. */
  expectedRewardRisk?: number;
  /** Stable evaluation timestamp for historical replay. */
  evaluatedAt?: string;
  metadataVersion?: string;
  /** Signal generated_at — used for entry/resolution lifecycle completeness. */
  signalGeneratedAt?: string | Date | null;
  /** Lifecycle status on the signal row at evaluation time. */
  signalStateAtResolution?: string | null;
  /** Explicit entry trigger timestamp when known (else first post-candle). */
  entryTimestamp?: string | null;
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

  const entryTsFromCandle = (() => {
    if (barsToEntry == null || !postCandles[barsToEntry]?.ts) return null;
    const t = postCandles[barsToEntry].ts!;
    return t instanceof Date ? t.toISOString() : String(t);
  })();
  const resolutionTsFromCandle = (() => {
    if (exitBar == null || !postCandles[exitBar]?.ts) {
      return lastCandleTs instanceof Date
        ? lastCandleTs.toISOString()
        : lastCandleTs
          ? String(lastCandleTs)
          : null;
    }
    const t = postCandles[exitBar].ts!;
    return t instanceof Date ? t.toISOString() : String(t);
  })();

  const resolved = stopBeforeTarget || target1BeforeStop || target2BeforeStop || target3BeforeStop;
  const barsUnresolved = resolved ? 0 : postCandles.length;

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
    timeToTarget2Bars: firstTarget2Bar,
    timeToTarget3Bars: firstTarget3Bar,
    timeToStopBars: firstStopBar,
    holdingDurationBars: exitBar == null ? 0 : exitBar + 1,
    barsUnresolved,
    entryTimestamp: options.entryTimestamp ?? entryTsFromCandle,
    resolutionTimestamp: resolutionTsFromCandle,
    signalGeneratedAt: options.signalGeneratedAt
      ? String(options.signalGeneratedAt)
      : null,
    signalStateAtResolution: options.signalStateAtResolution ?? (resolved ? 'resolved' : 'open_or_expired'),
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
  dims: { strategy?: string | null; regime?: string | null; volatilityState?: string | null } = {},
): ConfidenceCalibrationSnapshot {
  const rows: EmpiricalOutcomeRow[] = outcomes.map((o) => ({
    confidenceScore: 0,
    strategy: dims.strategy ?? 'all',
    regime: dims.regime ?? 'all',
    volatilityState: dims.volatilityState ?? null,
    target1Hit: o.target1Hit,
    entryTriggered: o.entryTriggered,
    expired: o.outcomeLabel === 'expired' || o.outcomeLabel === 'stale_no_trigger',
    maxFavorableExcursionPct: o.maxFavorableExcursionPct,
    maxAdverseExcursionPct: o.maxAdverseExcursionPct,
  }));

  const m = computeEmpiricalBucketMetrics(bucket, rows, dims);
  const prior = CALIBRATION_HIT_RATE_PRIORS[bucket] ?? 0.5;

  // Map empirical state onto legacy CalibrationState union
  let calibrationState: CalibrationState = 'insufficient_data';
  if (m.calibrationState === 'well_calibrated') calibrationState = 'well_calibrated';
  else if (m.calibrationState === 'overconfident') {
    calibrationState = m.actualPrecision < prior - 0.15 ? 'overconfident' : 'slightly_overconfident';
  } else if (m.calibrationState === 'underconfident') calibrationState = 'underconfident';

  return {
    bucket,
    sampleSize: m.sampleSize,
    target1HitRate: m.actualPrecision,
    avgMFE: m.avgMfe,
    calibrationState,
    priorHitRate: m.priorHitRate,
    wilsonLower: m.wilsonLower,
    wilsonUpper: m.wilsonUpper,
    brierScore: m.brierScore,
    expectedCalibrationError: m.expectedCalibrationError,
    avgMAE: m.avgMae,
    entryTriggerRate: m.entryTriggerRate,
    expiryRate: m.expiryRate,
    suggestedModifier: m.suggestedModifier,
    evidenceWeight: m.evidenceWeight,
    strategyName: dims.strategy ?? null,
    regime: dims.regime ?? null,
    volatilityState: dims.volatilityState ?? null,
    modelVersion: CONFIDENCE_MODEL_VERSION,
  };
}

// ── Adaptive Recommendation (Phase 8 — shrinkage + evidence) ─

const MAX_MODIFIER = 8; // absolute bound — cannot bypass Phase 3 rejection floors

export function computeAdaptiveRecommendation(
  perf: StrategyPerformanceSnapshot,
  opts: {
    timeWindowDays?: number;
    decayHalfLifeDays?: number;
    parentPriorModifier?: number;
    parentPriorSampleSize?: number;
  } = {},
): AdaptiveRecommendation {
  const timeWindowDays = opts.timeWindowDays ?? 90;
  const decayHalfLifeDays = opts.decayHalfLifeDays ?? 45;
  const parentPrior = opts.parentPriorModifier ?? 0;
  const parentN = opts.parentPriorSampleSize ?? 200;

  if (perf.sampleSize < 20) {
    return {
      strategyEnvironmentFit: 'insufficient_data',
      recommendedConfidenceModifier: 0,
      reason: 'Insufficient sample for recommendation',
      sampleSize: perf.sampleSize,
      evidenceStrength: 'weak',
      timeWindowDays,
      decayWeight: 0,
      parentGroupPrior: parentPrior,
      confidenceInterval: { lower: 0, upper: 1 },
      maxPermittedChange: 0,
      modelVersion: '8.0.0',
    };
  }

  let rawModifier = 0;
  if (perf.environmentFit === 'excellent') rawModifier = 5;
  else if (perf.environmentFit === 'good') rawModifier = 2;
  else if (perf.environmentFit === 'poor') rawModifier = -5;

  // Shrinkage toward parent-group prior — small/old samples pull less
  const evidenceWeight = perf.sampleSize / (perf.sampleSize + parentN * 0.25);
  const decayWeight = Math.exp(-Math.log(2) * (timeWindowDays / 2) / decayHalfLifeDays);
  const shrunk = parentPrior * (1 - evidenceWeight * decayWeight)
    + rawModifier * (evidenceWeight * decayWeight);

  const maxPermittedChange = perf.sampleSize >= 80
    ? MAX_MODIFIER
    : perf.sampleSize >= 50
      ? 5
      : perf.sampleSize >= 30
        ? 3
        : 2;

  const recommended = Math.max(
    -maxPermittedChange,
    Math.min(maxPermittedChange, Math.round(shrunk)),
  );

  // Wilson-ish CI on win rate
  const n = perf.sampleSize;
  const p = perf.winRate;
  const z = 1.96;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  const lower = Math.max(0, (centre - margin) / denom);
  const upper = Math.min(1, (centre + margin) / denom);

  const strength =
    perf.sampleSize >= 50 && decayWeight >= 0.5
      ? 'strong' as const
      : perf.sampleSize >= 30
        ? 'moderate' as const
        : 'weak' as const;

  const reason =
    `${perf.strategyName} in ${perf.regime}: win ${(perf.winRate * 100).toFixed(0)}% ` +
    `n=${perf.sampleSize} window=${timeWindowDays}d decay=${decayWeight.toFixed(2)} ` +
    `shrink→${recommended} (raw ${rawModifier}, prior ${parentPrior}, cap ±${maxPermittedChange})`;

  return {
    strategyEnvironmentFit: perf.environmentFit,
    recommendedConfidenceModifier: recommended,
    reason,
    sampleSize: perf.sampleSize,
    evidenceStrength: strength,
    timeWindowDays,
    decayWeight: Math.round(decayWeight * 1000) / 1000,
    parentGroupPrior: parentPrior,
    confidenceInterval: {
      lower: Math.round(lower * 1000) / 1000,
      upper: Math.round(upper * 1000) / 1000,
    },
    maxPermittedChange,
    modelVersion: '8.0.0',
  };
}

// ── Default Feedback State ──────────────────────────────────

export function defaultFeedbackState(): FeedbackState {
  return { strategyRecentWinRate: null, strategyEnvironmentFit: 'insufficient_data', confidenceCalibrationState: 'insufficient_data' };
}
