// ════════════════════════════════════════════════════════════════
//  News Calibration Engine
//
//  Aggregates outcome statistics by three dimensions:
//    1. Event type (category)  — do earnings news signals outperform?
//    2. Source                  — is Finnhub more reliable than GNews?
//    3. Sentiment bucket        — does bullish sentiment predict wins?
//
//  Tracks: win rate, pnlR, MFE, MAE per bucket.
//  Classifies calibration state for the adaptive engine.
//
//  RULES:
//    - All logic deterministic — no ML
//    - Minimum 10 outcomes per bucket to classify
//    - All results auditable in q365_news_calibration
// ════════════════════════════════════════════════════════════════

import type {
  NewsLinkedOutcome,
  NewsCategoryCalibration,
  NewsSourceCalibration,
  NewsSentimentCalibration,
  NewsCalibrationState,
} from '../types/feedback.types';
import type { NewsCategory, NewsSourceId, SentimentLabel } from '../types/newsEngine.types';

const MIN_SAMPLE_SIZE = 10;

// ── Helpers ──────────────────────────────────────────────────────

function isWin(o: NewsLinkedOutcome): boolean {
  return o.target1Hit;
}

function computePnlR(o: NewsLinkedOutcome): number {
  // Approximate R-multiple from MFE. If stopped, it's -1R.
  if (o.stopHit && !o.target1Hit) return -1;
  if (o.target2Hit) return 2;
  if (o.target1Hit) return 1;
  return o.returnBar10Pct != null ? o.returnBar10Pct / 2 : 0;
}

function classifyCalibration(
  winRate: number,
  expectedWinRate: number,
  sentimentAccuracy?: number,
): NewsCalibrationState {
  const diff = winRate - expectedWinRate;

  if (sentimentAccuracy != null && sentimentAccuracy < 0.35) {
    return 'contrarian_signal';
  }
  if (Math.abs(diff) < 0.06) return 'well_calibrated';
  if (diff < -0.15) return 'overweight';
  if (diff < -0.06) return 'slightly_overweight';
  if (diff > 0.06) return 'underweight';
  return 'well_calibrated';
}

// ════════════════════════════════════════════════════════════════
//  1. CALIBRATE BY EVENT TYPE (CATEGORY)
// ════════════════════════════════════════════════════════════════

// Expected win rates by category (prior from market observation)
const CATEGORY_EXPECTED_WIN: Partial<Record<NewsCategory, number>> = {
  earnings:           0.52,
  merger_acquisition: 0.48,
  regulatory:         0.40,
  macro_policy:       0.45,
  management_change:  0.42,
  insider_trade:      0.38,
  credit_rating:      0.50,
  corporate_action:   0.55,
  commodity:          0.47,
  sector_move:        0.50,
  global_cue:         0.44,
  general:            0.48,
  ipo_listing:        0.45,
};

export function calibrateByCategory(
  outcomes: NewsLinkedOutcome[],
): NewsCategoryCalibration[] {
  const now = new Date().toISOString();
  const byCategory = new Map<NewsCategory, NewsLinkedOutcome[]>();

  for (const o of outcomes) {
    const list = byCategory.get(o.newsCategory) ?? [];
    list.push(o);
    byCategory.set(o.newsCategory, list);
  }

  const results: NewsCategoryCalibration[] = [];
  for (const [category, items] of byCategory) {
    const n = items.length;
    if (n < MIN_SAMPLE_SIZE) {
      results.push({
        category, sampleSize: n, winRate: 0, avgPnlR: 0, avgMFE: 0,
        avgMAE: 0, target1HitRate: 0, target2HitRate: 0, stopRate: 0,
        calibrationState: 'insufficient_data', computedAt: now,
      });
      continue;
    }

    const wins = items.filter(isWin).length;
    const winRate = round(wins / n);
    const t1Rate = winRate;
    const t2Rate = round(items.filter((o) => o.target2Hit).length / n);
    const stopRate = round(items.filter((o) => o.stopHit && !o.target1Hit).length / n);
    const avgPnlR = round(items.reduce((s, o) => s + computePnlR(o), 0) / n, 3);
    const avgMFE = round(items.reduce((s, o) => s + o.mfePct, 0) / n, 3);
    const avgMAE = round(items.reduce((s, o) => s + o.maePct, 0) / n, 3);

    const expected = CATEGORY_EXPECTED_WIN[category] ?? 0.48;
    const calibrationState = classifyCalibration(winRate, expected);

    results.push({
      category, sampleSize: n, winRate, avgPnlR, avgMFE, avgMAE,
      target1HitRate: t1Rate, target2HitRate: t2Rate, stopRate,
      calibrationState, computedAt: now,
    });
  }

  return results;
}

// ════════════════════════════════════════════════════════════════
//  2. CALIBRATE BY SOURCE
// ════════════════════════════════════════════════════════════════

const SOURCE_EXPECTED_WIN: Record<NewsSourceId, number> = {
  official_exchange:  0.55,
  corporate_filings:  0.54,
  finnhub:            0.52,
  rss_et:             0.50,
  rss_mc:             0.49,
  newsdata:           0.47,
  newsapi:            0.46,
  gnews:              0.45,
  deals_feed:         0.51,
  social_signals:     0.40,
};

export function calibrateBySource(
  outcomes: NewsLinkedOutcome[],
): NewsSourceCalibration[] {
  const now = new Date().toISOString();
  const bySource = new Map<NewsSourceId, NewsLinkedOutcome[]>();

  for (const o of outcomes) {
    const list = bySource.get(o.newsSourceId) ?? [];
    list.push(o);
    bySource.set(o.newsSourceId, list);
  }

  const results: NewsSourceCalibration[] = [];
  for (const [sourceId, items] of bySource) {
    const n = items.length;
    if (n < MIN_SAMPLE_SIZE) {
      results.push({
        sourceId, sampleSize: n, winRate: 0, avgPnlR: 0, avgMFE: 0,
        avgMAE: 0, sentimentAccuracy: 0, calibrationState: 'insufficient_data',
        calibratedTrust: 50, computedAt: now,
      });
      continue;
    }

    const wins = items.filter(isWin).length;
    const winRate = round(wins / n);
    const avgPnlR = round(items.reduce((s, o) => s + computePnlR(o), 0) / n, 3);
    const avgMFE = round(items.reduce((s, o) => s + o.mfePct, 0) / n, 3);
    const avgMAE = round(items.reduce((s, o) => s + o.maePct, 0) / n, 3);

    // Sentiment accuracy: did positive sentiment correlate with wins?
    const sentimentMatches = items.filter((o) => {
      if (o.sentimentScore > 10 && isWin(o)) return true;
      if (o.sentimentScore < -10 && !isWin(o)) return true;
      return false;
    }).length;
    const sentimentAccuracy = round(sentimentMatches / n);

    const expected = SOURCE_EXPECTED_WIN[sourceId] ?? 0.48;
    const calibrationState = classifyCalibration(winRate, expected, sentimentAccuracy);

    // Calibrated trust: adjust base trust by outcome performance
    const baseTrust = { finnhub: 82, newsdata: 68, gnews: 55, rss_et: 75, rss_mc: 72 }[sourceId] ?? 50;
    const trustDelta = winRate > expected + 0.05 ? 5 : winRate < expected - 0.10 ? -10 : 0;
    const calibratedTrust = clamp(baseTrust + trustDelta, 10, 95);

    results.push({
      sourceId, sampleSize: n, winRate, avgPnlR, avgMFE, avgMAE,
      sentimentAccuracy, calibrationState, calibratedTrust, computedAt: now,
    });
  }

  return results;
}

// ════════════════════════════════════════════════════════════════
//  3. CALIBRATE BY SENTIMENT
// ════════════════════════════════════════════════════════════════

function sentimentBucket(score: number): SentimentLabel {
  if (score >= 40) return 'strongly_positive';
  if (score > 10) return 'positive';
  if (score > -10) return 'neutral';
  if (score > -40) return 'negative';
  return 'strongly_negative';
}

const SENTIMENT_EXPECTED_WIN: Record<SentimentLabel, number> = {
  strongly_positive:  0.55,
  positive:           0.52,
  neutral:            0.48,
  negative:           0.44,
  strongly_negative:  0.40,
};

export function calibrateBySentiment(
  outcomes: NewsLinkedOutcome[],
): NewsSentimentCalibration[] {
  const now = new Date().toISOString();
  const byBucket = new Map<SentimentLabel, NewsLinkedOutcome[]>();

  for (const o of outcomes) {
    const bucket = sentimentBucket(o.sentimentScore);
    const list = byBucket.get(bucket) ?? [];
    list.push(o);
    byBucket.set(bucket, list);
  }

  const results: NewsSentimentCalibration[] = [];
  for (const [bucket, items] of byBucket) {
    const n = items.length;
    if (n < MIN_SAMPLE_SIZE) {
      results.push({
        sentimentBucket: bucket, sampleSize: n, winRate: 0, avgPnlR: 0,
        avgMFE: 0, avgMAE: 0, directionAccuracy: 0,
        calibrationState: 'insufficient_data', computedAt: now,
      });
      continue;
    }

    const wins = items.filter(isWin).length;
    const winRate = round(wins / n);
    const avgPnlR = round(items.reduce((s, o) => s + computePnlR(o), 0) / n, 3);
    const avgMFE = round(items.reduce((s, o) => s + o.mfePct, 0) / n, 3);
    const avgMAE = round(items.reduce((s, o) => s + o.maePct, 0) / n, 3);

    // Direction accuracy: positive sentiment → win, negative → loss
    const directionCorrect = items.filter((o) => {
      if (o.sentimentScore > 10 && isWin(o)) return true;
      if (o.sentimentScore < -10 && o.stopHit && !o.target1Hit) return true;
      return false;
    }).length;
    const directionAccuracy = round(directionCorrect / n);

    const expected = SENTIMENT_EXPECTED_WIN[bucket] ?? 0.48;
    const calibrationState = classifyCalibration(winRate, expected, directionAccuracy);

    results.push({
      sentimentBucket: bucket, sampleSize: n, winRate, avgPnlR, avgMFE,
      avgMAE, directionAccuracy, calibrationState, computedAt: now,
    });
  }

  return results;
}

// ── Utility ──────────────────────────────────────────────────────

function round(val: number, decimals = 4): number {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
