// ════════════════════════════════════════════════════════════════
//  News Calibration Pipeline (Job F)
//
//  Orchestrates the full calibration run:
//    1. Load news-linked outcomes (signal_news_linkage → outcomes)
//    2. Calibrate by category, source, sentiment
//    3. Generate adaptive recommendations
//    4. Persist all results
//
//  Called by the learning scheduler as Job F.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from '../repository/ensureNewsSchemas';
import { loadNewsLinkedOutcomes } from './linkageTracker';
import {
  calibrateByCategory,
  calibrateBySource,
  calibrateBySentiment,
} from './calibrationEngine';
import {
  generateCategoryRecommendations,
  generateSourceRecommendations,
  generateSentimentRecommendations,
} from './adaptiveEngine';
import type {
  NewsCalibrationResult,
  NewsAdaptiveRecommendation,
  NewsCategoryCalibration,
  NewsSourceCalibration,
  NewsSentimentCalibration,
} from '../types/feedback.types';

// ── Sanity Check Constants ───────────────────────────────────────

const MIN_CALIBRATION_SAMPLE = 10;       // minimum outcomes to trust a bucket
const MAX_DAILY_MODIFIER_CHANGE = 3;     // max ±change per calibration run

// ── Enriched Bucket Calibration ─────────────────────────────────

interface BucketCalibration {
  dimension: string;
  bucket: string;
  sampleSize: number;
  winRate: number;
  avgPnlR: number;
  avgMFE: number;
  avgMAE: number;
  calibrationState: string;
}

function calibrateByBucket(
  outcomes: Array<any>,
  dimension: 'impact' | 'event_risk' | 'manipulation',
): BucketCalibration[] {
  const fieldMap: Record<string, string> = {
    impact: 'newsImpactScore',
    event_risk: 'newsEventRisk',
    manipulation: 'newsManipulationScore',
  };
  const field = fieldMap[dimension] ?? dimension;

  // Bucket outcomes by score range
  const buckets = new Map<string, any[]>();
  for (const o of outcomes) {
    const score = Number(o[field] ?? o.impactScore ?? 0);
    let bucket: string;
    if (score < 20) bucket = 'very_low';
    else if (score < 40) bucket = 'low';
    else if (score < 60) bucket = 'medium';
    else if (score < 80) bucket = 'high';
    else bucket = 'very_high';

    const list = buckets.get(bucket) ?? [];
    list.push(o);
    buckets.set(bucket, list);
  }

  const results: BucketCalibration[] = [];
  for (const [bucket, items] of buckets) {
    const n = items.length;
    if (n === 0) continue;

    const wins = items.filter(o => o.outcomeLabel === 'good_followthrough' || o.outcomeLabel === 'partial_success').length;
    const winRate = n > 0 ? wins / n : 0;
    const avgPnlR = items.reduce((s: number, o: any) => s + (Number(o.pnlR) || 0), 0) / n;
    const avgMFE = items.reduce((s: number, o: any) => s + (Number(o.maxFavorableExcursionPct) || 0), 0) / n;
    const avgMAE = items.reduce((s: number, o: any) => s + Math.abs(Number(o.maxAdverseExcursionPct) || 0), 0) / n;

    let calibrationState = 'neutral';
    if (n < MIN_CALIBRATION_SAMPLE) calibrationState = 'insufficient_data';
    else if (winRate > 0.6 && avgPnlR > 0.3) calibrationState = 'contributing_positively';
    else if (winRate < 0.4 || avgPnlR < -0.2) calibrationState = 'needs_recalibration';

    results.push({
      dimension: `${dimension}_bucket`,
      bucket,
      sampleSize: n,
      winRate: Math.round(winRate * 1000) / 1000,
      avgPnlR: Math.round(avgPnlR * 1000) / 1000,
      avgMFE: Math.round(avgMFE * 1000) / 1000,
      avgMAE: Math.round(avgMAE * 1000) / 1000,
      calibrationState,
    });
  }

  return results;
}

// ── Persistence ──────────────────────────────────────────────────

async function clearTodaysNewsCalibration(): Promise<void> {
  await db.query(
    `DELETE FROM q365_news_calibration WHERE DATE(computed_at) = CURDATE()`,
  ).catch(() => {});
  await db.query(
    `DELETE FROM q365_news_adaptive_recommendations WHERE DATE(computed_at) = CURDATE()`,
  ).catch(() => {});
}

async function saveCalibrationRow(
  dimension: string,
  dimensionValue: string,
  row: {
    sampleSize: number; winRate: number; avgPnlR: number;
    avgMFE: number; avgMAE: number; calibrationState: string;
    sentimentAccuracy?: number; calibratedTrust?: number;
    target1HitRate?: number; target2HitRate?: number; stopRate?: number;
    computedAt: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO q365_news_calibration
       (dimension, dimension_value, sample_size, win_rate, avg_pnl_r,
        avg_mfe, avg_mae, target1_hit_rate, target2_hit_rate, stop_rate,
        sentiment_accuracy, calibrated_trust, calibration_state, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      dimension,
      dimensionValue,
      row.sampleSize,
      row.winRate,
      row.avgPnlR,
      row.avgMFE,
      row.avgMAE,
      row.target1HitRate ?? 0,
      row.target2HitRate ?? 0,
      row.stopRate ?? 0,
      row.sentimentAccuracy ?? 0,
      row.calibratedTrust ?? 50,
      row.calibrationState,
      row.computedAt,
    ],
  );
}

async function saveRecommendation(rec: NewsAdaptiveRecommendation): Promise<void> {
  await db.query(
    `INSERT INTO q365_news_adaptive_recommendations
       (dimension, dimension_value, current_modifier, recommended_modifier,
        trust_adjustment, reason, sample_size, evidence_strength, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.dimension,
      rec.dimensionValue,
      rec.currentModifier,
      rec.recommendedModifier,
      rec.trustAdjustment,
      rec.reason,
      rec.sampleSize,
      rec.evidenceStrength,
      rec.computedAt,
    ],
  );
}

// ── Main Pipeline ────────────────────────────────────────────────

export async function runNewsCalibration(
  lookbackDays = 90,
): Promise<NewsCalibrationResult> {
  await ensureNewsSchemas();
  const startMs = Date.now();

  // Idempotency: clear today's results before recomputing
  await clearTodaysNewsCalibration();

  // Step 1: Load outcomes linked to news events
  const rawOutcomes = await loadNewsLinkedOutcomes(lookbackDays);
  console.log(`[newsCalibration] loaded ${rawOutcomes.length} raw news-linked outcomes`);

  // Step 1b: Validate linkages — reject incomplete/invalid rows
  const outcomes = rawOutcomes.filter((o) => {
    if (!o.signalId || !o.newsEventId) return false;
    if (!o.outcomeLabel) return false;
    return true;
  });

  // Linkage coverage metrics
  const totalSignals = new Set(rawOutcomes.map(o => o.signalId)).size;
  const validSignals = new Set(outcomes.map(o => o.signalId)).size;
  const directSymbolLinks = outcomes.filter(o => o.newsCategory !== 'general' && o.newsCategory !== 'global_cue').length;
  const sectorMarketLinks = outcomes.filter(o => o.newsCategory === 'global_cue' || o.newsCategory === 'sector_move').length;
  const droppedInvalid = rawOutcomes.length - outcomes.length;

  console.log(
    `[newsCalibration] validation: total_signals=${totalSignals} valid=${validSignals} ` +
    `direct_links=${directSymbolLinks} sector_market=${sectorMarketLinks} dropped=${droppedInvalid}`,
  );

  if (outcomes.length === 0) {
    return {
      categoryCalibrations: [],
      sourceCalibrations: [],
      sentimentCalibrations: [],
      recommendations: [],
      linkedOutcomesUsed: 0,
      durationMs: Date.now() - startMs,
    };
  }

  // Step 2: Calibrate all three dimensions
  const categoryCalibrations = calibrateByCategory(outcomes);
  const sourceCalibrations = calibrateBySource(outcomes);
  const sentimentCalibrations = calibrateBySentiment(outcomes);

  // Step 2b: Calibrate by enriched dimensions (impact, risk, manipulation buckets)
  const impactBucketCalibrations = calibrateByBucket(outcomes, 'impact');
  const riskBucketCalibrations = calibrateByBucket(outcomes, 'event_risk');
  const manipBucketCalibrations = calibrateByBucket(outcomes, 'manipulation');

  // Step 3: Generate adaptive recommendations
  const catRecs = generateCategoryRecommendations(categoryCalibrations);
  const srcRecs = generateSourceRecommendations(sourceCalibrations);
  const sentRecs = generateSentimentRecommendations(sentimentCalibrations);
  const recommendations = [...catRecs, ...srcRecs, ...sentRecs];

  // Step 3b: Apply sanity checks — bound daily parameter changes
  for (const rec of recommendations) {
    // Min sample size: at least 10 to avoid overfitting
    if (rec.sampleSize < MIN_CALIBRATION_SAMPLE) {
      rec.evidenceStrength = 'weak';
      rec.reason = `[SANITY] Sample size ${rec.sampleSize} < ${MIN_CALIBRATION_SAMPLE} — recommendation weakened. ${rec.reason}`;
    }
    // Bound daily modifier change to ±3 to prevent oscillation
    const delta = rec.recommendedModifier - rec.currentModifier;
    if (Math.abs(delta) > MAX_DAILY_MODIFIER_CHANGE) {
      rec.recommendedModifier = rec.currentModifier + Math.sign(delta) * MAX_DAILY_MODIFIER_CHANGE;
      rec.reason = `[SANITY] Modifier change capped to ±${MAX_DAILY_MODIFIER_CHANGE}/day. ${rec.reason}`;
    }
  }

  // Step 4: Persist calibration rows
  for (const cal of categoryCalibrations) {
    await saveCalibrationRow('category', cal.category, cal).catch((err) => {
      console.warn(`[newsCalibration] save category failed:`, (err as Error).message);
    });
  }
  for (const cal of sourceCalibrations) {
    await saveCalibrationRow('source', cal.sourceId, {
      ...cal,
      sentimentAccuracy: cal.sentimentAccuracy,
      calibratedTrust: cal.calibratedTrust,
    }).catch((err) => {
      console.warn(`[newsCalibration] save source failed:`, (err as Error).message);
    });
  }
  for (const cal of sentimentCalibrations) {
    await saveCalibrationRow('sentiment', cal.sentimentBucket, {
      ...cal,
      sentimentAccuracy: cal.directionAccuracy,
    }).catch((err) => {
      console.warn(`[newsCalibration] save sentiment failed:`, (err as Error).message);
    });
  }
  // Persist enriched bucket calibrations
  for (const cal of [...impactBucketCalibrations, ...riskBucketCalibrations, ...manipBucketCalibrations]) {
    await saveCalibrationRow(cal.dimension, cal.bucket, {
      sampleSize: cal.sampleSize,
      winRate: cal.winRate,
      avgPnlR: cal.avgPnlR,
      avgMFE: cal.avgMFE,
      avgMAE: cal.avgMAE,
      calibrationState: cal.calibrationState,
      computedAt: new Date().toISOString(),
    }).catch((err) => {
      console.warn(`[newsCalibration] save ${cal.dimension} bucket failed:`, (err as Error).message);
    });
  }

  // Step 5: Persist recommendations
  for (const rec of recommendations) {
    await saveRecommendation(rec).catch((err) => {
      console.warn(`[newsCalibration] save rec failed:`, (err as Error).message);
    });
  }

  const durationMs = Date.now() - startMs;
  console.log(
    `[newsCalibration] done: categories=${categoryCalibrations.length} ` +
    `sources=${sourceCalibrations.length} sentiments=${sentimentCalibrations.length} ` +
    `recs=${recommendations.length} (${durationMs}ms)`,
  );

  return {
    categoryCalibrations,
    sourceCalibrations,
    sentimentCalibrations,
    recommendations,
    linkedOutcomesUsed: outcomes.length,
    durationMs,
  };
}
