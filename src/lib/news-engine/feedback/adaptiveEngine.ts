// ════════════════════════════════════════════════════════════════
//  News Adaptive Engine
//
//  Generates BOUNDED recommendations from calibration data.
//  Updates trust scores and modifier weights.
//
//  RULES:
//    - NO auto rule rewrite — recommendations are suggestions only
//    - NO black-box AI — all logic is explicit, auditable
//    - Modifier adjustments bounded ±3 from current
//    - Trust adjustments bounded ±15 from base
//    - Minimum 20 outcomes for any recommendation
//    - All changes logged in q365_news_adaptive_recommendations
// ════════════════════════════════════════════════════════════════

import type {
  NewsCategoryCalibration,
  NewsSourceCalibration,
  NewsSentimentCalibration,
  NewsAdaptiveRecommendation,
  NewsCalibrationState,
} from '../types/feedback.types';

const MIN_RECOMMENDATION_SAMPLE = 20;
const MAX_MODIFIER_DELTA = 3;     // ±3 from current
const MAX_TRUST_DELTA = 15;       // ±15 from base

// ── Evidence Strength ────────────────────────────────────────────

function evidenceStrength(sampleSize: number): 'strong' | 'moderate' | 'weak' {
  if (sampleSize >= 100) return 'strong';
  if (sampleSize >= 40) return 'moderate';
  return 'weak';
}

// ── Modifier Delta from Calibration State ────────────────────────

function modifierDelta(state: NewsCalibrationState): number {
  switch (state) {
    case 'overweight':          return -3;  // reduce influence
    case 'slightly_overweight': return -1;  // minor reduction
    case 'underweight':         return +2;  // increase influence
    case 'contrarian_signal':   return -3;  // sentiment inversely correlated — dampen
    case 'well_calibrated':     return 0;
    case 'insufficient_data':   return 0;
    default:                    return 0;
  }
}

// ════════════════════════════════════════════════════════════════
//  GENERATE RECOMMENDATIONS
// ════════════════════════════════════════════════════════════════

export function generateCategoryRecommendations(
  calibrations: NewsCategoryCalibration[],
): NewsAdaptiveRecommendation[] {
  const now = new Date().toISOString();
  const recs: NewsAdaptiveRecommendation[] = [];

  for (const cal of calibrations) {
    if (cal.sampleSize < MIN_RECOMMENDATION_SAMPLE) continue;
    if (cal.calibrationState === 'insufficient_data') continue;

    const delta = modifierDelta(cal.calibrationState);
    if (delta === 0) continue;  // no change needed

    const recommended = clamp(delta, -MAX_MODIFIER_DELTA, MAX_MODIFIER_DELTA);

    recs.push({
      dimension:           'category',
      dimensionValue:      cal.category,
      currentModifier:     0,  // will be resolved at application time
      recommendedModifier: recommended,
      trustAdjustment:     0,
      reason:              buildReason('category', cal.category, cal.calibrationState, cal.winRate, cal.sampleSize),
      sampleSize:          cal.sampleSize,
      evidenceStrength:    evidenceStrength(cal.sampleSize),
      computedAt:          now,
    });
  }

  return recs;
}

export function generateSourceRecommendations(
  calibrations: NewsSourceCalibration[],
): NewsAdaptiveRecommendation[] {
  const now = new Date().toISOString();
  const recs: NewsAdaptiveRecommendation[] = [];

  for (const cal of calibrations) {
    if (cal.sampleSize < MIN_RECOMMENDATION_SAMPLE) continue;
    if (cal.calibrationState === 'insufficient_data') continue;

    const delta = modifierDelta(cal.calibrationState);

    // Trust adjustment: based on calibrated vs base trust
    const baseTrust = { finnhub: 82, newsdata: 68, gnews: 55, rss_et: 75, rss_mc: 72 }[cal.sourceId] ?? 50;
    const trustDelta = clamp(cal.calibratedTrust - baseTrust, -MAX_TRUST_DELTA, MAX_TRUST_DELTA);

    if (delta === 0 && trustDelta === 0) continue;

    recs.push({
      dimension:           'source',
      dimensionValue:      cal.sourceId,
      currentModifier:     0,
      recommendedModifier: clamp(delta, -MAX_MODIFIER_DELTA, MAX_MODIFIER_DELTA),
      trustAdjustment:     trustDelta,
      reason:              buildReason('source', cal.sourceId, cal.calibrationState, cal.winRate, cal.sampleSize, trustDelta),
      sampleSize:          cal.sampleSize,
      evidenceStrength:    evidenceStrength(cal.sampleSize),
      computedAt:          now,
    });
  }

  return recs;
}

export function generateSentimentRecommendations(
  calibrations: NewsSentimentCalibration[],
): NewsAdaptiveRecommendation[] {
  const now = new Date().toISOString();
  const recs: NewsAdaptiveRecommendation[] = [];

  for (const cal of calibrations) {
    if (cal.sampleSize < MIN_RECOMMENDATION_SAMPLE) continue;
    if (cal.calibrationState === 'insufficient_data') continue;

    const delta = modifierDelta(cal.calibrationState);
    if (delta === 0) continue;

    recs.push({
      dimension:           'sentiment',
      dimensionValue:      cal.sentimentBucket,
      currentModifier:     0,
      recommendedModifier: clamp(delta, -MAX_MODIFIER_DELTA, MAX_MODIFIER_DELTA),
      trustAdjustment:     0,
      reason:              buildReason('sentiment', cal.sentimentBucket, cal.calibrationState, cal.winRate, cal.sampleSize),
      sampleSize:          cal.sampleSize,
      evidenceStrength:    evidenceStrength(cal.sampleSize),
      computedAt:          now,
    });
  }

  return recs;
}

// ── Reason Builder ───────────────────────────────────────────────

function buildReason(
  dimension: string,
  value: string,
  state: NewsCalibrationState,
  winRate: number,
  sampleSize: number,
  trustDelta?: number,
): string {
  const winPct = (winRate * 100).toFixed(1);
  const evidence = evidenceStrength(sampleSize);

  let base = `${dimension}="${value}": ${state} (win rate ${winPct}% over ${sampleSize} signals, ${evidence} evidence)`;

  switch (state) {
    case 'overweight':
      base += '. Recommendation: reduce news modifier weight — outcomes underperform expectations.';
      break;
    case 'slightly_overweight':
      base += '. Recommendation: minor reduction in news modifier weight.';
      break;
    case 'underweight':
      base += '. Recommendation: increase news modifier weight — outcomes outperform expectations.';
      break;
    case 'contrarian_signal':
      base += '. WARNING: sentiment inversely correlated with outcomes — consider dampening sentiment influence.';
      break;
    case 'well_calibrated':
      base += '. No adjustment needed.';
      break;
  }

  if (trustDelta && trustDelta !== 0) {
    base += ` Trust adjustment: ${trustDelta > 0 ? '+' : ''}${trustDelta}.`;
  }

  return base;
}

// ── Utility ──────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
