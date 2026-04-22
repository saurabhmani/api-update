// ════════════════════════════════════════════════════════════════
//  News Feedback + Calibration — Type System (Phase 4)
//
//  Links news → signals → outcomes for controlled learning.
//
//  RULES:
//    - NO auto rule rewrite — recommendations are bounded suggestions
//    - NO black-box AI — all logic is deterministic, auditable
//    - All changes traceable in calibration tables
// ════════════════════════════════════════════════════════════════

import type { NewsSourceId, NewsCategory, SentimentLabel } from './newsEngine.types';
import type { OutcomeLabel } from '@/lib/signal-engine/types/phase4.types';

// ── News → Signal Linkage ────────────────────────────────────────

export interface NewsSignalLinkage {
  signalId:              number;
  newsEventId:           number;
  symbol:                string;
  /** How much this event contributed to the signal modifier. */
  impactContribution:    number;   // 0–100
  /** Trust at time of linkage. */
  trustAtLinkage:        number;   // 0–100
  /** Sentiment at time of linkage. */
  sentimentAtLinkage:    number;   // -100 to +100
  /** Confidence modifier applied. */
  modifierApplied:       number;   // ±8
  /** Type of linkage: how the news event relates to the signal. */
  linkageType?:          'direct_symbol' | 'sector' | 'market' | 'fallback';
  /** Confidence in the linkage quality (0-100). */
  linkageConfidence?:    number;   // 0–100
  /** When the signal was generated (for temporal audit). */
  signalGeneratedAt?:    string;   // ISO-8601
  /** When the news event was published (for temporal audit). */
  newsEventPublishedAt?: string;   // ISO-8601
  /** Version of the scoring model used. */
  scoringVersion?:       string;
  linkedAt:              string;   // ISO-8601
}

// ── Outcome with News Context ────────────────────────────────────

export interface NewsLinkedOutcome {
  signalId:         number;
  symbol:           string;
  newsEventId:      number;
  newsCategory:     NewsCategory;
  newsSourceId:     NewsSourceId;
  newsSentiment:    SentimentLabel;
  sentimentScore:   number;     // -100 to +100
  trustScore:       number;     // 0–100
  importanceScore:  number;     // 0–100
  modifierApplied:  number;     // ±8
  // Outcome fields
  outcomeLabel:     OutcomeLabel;
  target1Hit:       boolean;
  target2Hit:       boolean;
  stopHit:          boolean;
  mfePct:           number;
  maePct:           number;
  returnBar5Pct:    number | null;
  returnBar10Pct:   number | null;
}

// ── Calibration by Event Type ────────────────────────────────────

export interface NewsCategoryCalibration {
  category:           NewsCategory;
  sampleSize:         number;
  winRate:            number;     // 0–1 (fraction)
  avgPnlR:            number;     // average return in R-multiples
  avgMFE:             number;
  avgMAE:             number;
  target1HitRate:     number;     // 0–1
  target2HitRate:     number;     // 0–1
  stopRate:           number;     // 0–1 (stopped out rate)
  calibrationState:   NewsCalibrationState;
  computedAt:         string;
}

// ── Calibration by Source ────────────────────────────────────────

export interface NewsSourceCalibration {
  sourceId:           NewsSourceId;
  sampleSize:         number;
  winRate:            number;
  avgPnlR:            number;
  avgMFE:             number;
  avgMAE:             number;
  /** How reliable this source's sentiment turned out to be. */
  sentimentAccuracy:  number;     // 0–1 (positive sentiment → positive outcome)
  calibrationState:   NewsCalibrationState;
  /** Updated trust score based on outcome data. */
  calibratedTrust:    number;     // 0–100
  computedAt:         string;
}

// ── Calibration by Sentiment ─────────────────────────────────────

export interface NewsSentimentCalibration {
  sentimentBucket:    'strongly_positive' | 'positive' | 'neutral' | 'negative' | 'strongly_negative';
  sampleSize:         number;
  winRate:            number;
  avgPnlR:            number;
  avgMFE:             number;
  avgMAE:             number;
  /** Did the sentiment direction predict the outcome? */
  directionAccuracy:  number;     // 0–1
  calibrationState:   NewsCalibrationState;
  computedAt:         string;
}

// ── Calibration State ────────────────────────────────────────────

export type NewsCalibrationState =
  | 'well_calibrated'       // news modifier and outcome aligned
  | 'slightly_overweight'   // news gave too much credit; dampen
  | 'overweight'            // news seriously over-influenced; reduce
  | 'underweight'           // news impact was too conservative; boost
  | 'contrarian_signal'     // opposite of expected — sentiment inversely correlated
  | 'insufficient_data';    // <10 outcomes

// ── Adaptive Recommendation ──────────────────────────────────────

export interface NewsAdaptiveRecommendation {
  dimension:            'category' | 'source' | 'sentiment';
  dimensionValue:       string;   // e.g. 'earnings', 'gnews', 'positive'
  currentModifier:      number;   // what we're currently applying
  recommendedModifier:  number;   // bounded suggestion
  trustAdjustment:      number;   // ±15 max
  reason:               string;   // human-readable justification
  sampleSize:           number;
  evidenceStrength:     'strong' | 'moderate' | 'weak';
  computedAt:           string;
}

// ── Calibration Run Result ───────────────────────────────────────

export interface NewsCalibrationResult {
  categoryCalibrations:   NewsCategoryCalibration[];
  sourceCalibrations:     NewsSourceCalibration[];
  sentimentCalibrations:  NewsSentimentCalibration[];
  recommendations:        NewsAdaptiveRecommendation[];
  linkedOutcomesUsed:     number;
  durationMs:             number;
}
