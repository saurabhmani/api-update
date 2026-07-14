// ════════════════════════════════════════════════════════════════
//  Data-quality decision gate (Phase 1.5) — SINGLE canonical influence
//
//  Critical  → reject before strategy evaluation
//  Moderate  → cap confidence + mark non-actionable
//  Minor     → warning + one score modifier only
//
//  Do NOT apply DQ penalties again in confidenceScorer, ranking, or
//  Phase-4 structural scoring — this module owns the DQ modifier.
// ════════════════════════════════════════════════════════════════

import type { IntegrityIssue, IntegrityIssueCode } from '@/lib/marketData/integrity/marketDataIntegrity';
import type {
  DataQualitySeverity,
  DataQualitySnapshotFields,
  FreshnessStatusLabel,
} from './canonicalInputSnapshot';
import { recordDataQualityRejection } from './dqCounters';

const CRITICAL_CODES: ReadonlySet<IntegrityIssueCode> = new Set([
  'MISSING_CANDLE',
  'FUTURE_TIMESTAMP',
  'INVALID_OHLC',
  'NEGATIVE_PRICE',
  'NEGATIVE_VOLUME',
  'INCOMPLETE_CURRENT_CANDLE',
  'INSUFFICIENT_WARMUP',
  'PROVIDER_DISAGREEMENT',
]);

const MODERATE_CODES: ReadonlySet<IntegrityIssueCode> = new Set([
  'NON_MONOTONIC_TIMESTAMPS',
  'MISSING_SESSIONS',
  'STALE_BENCHMARK',
  'STALE_SECTOR',
  'DUPLICATE_TIMESTAMP',
]);

const MINOR_CODES: ReadonlySet<IntegrityIssueCode> = new Set([
  'ZERO_VOLUME',
  'SPLIT_ANOMALY',
  'TIMEZONE_AMBIGUOUS',
]);

export interface DataQualityDecisionInput {
  issues:           IntegrityIssue[];
  freshnessStatus:  FreshnessStatusLabel;
  /** Incomplete last bar (session still open / warehouse partial). */
  incompleteCurrent?: boolean;
  provider?:        string;
  /** Soft env defaults — pass from scan config when available. */
  minorModifierPts?: number;
  moderateConfidenceCap?: number;
}

export interface DataQualityDecision extends DataQualitySnapshotFields {
  /** Reject before runAllStrategies when true. */
  rejectBeforeStrategies: boolean;
  /** Block Fib / structure strategies (corporate-action unexplained jump). */
  blockStructureStrategies: boolean;
}

function highestSeverity(codes: IntegrityIssueCode[]): DataQualitySeverity {
  if (codes.some((c) => CRITICAL_CODES.has(c))) return 'critical';
  if (codes.some((c) => MODERATE_CODES.has(c))) return 'moderate';
  if (codes.some((c) => MINOR_CODES.has(c))) return 'minor';
  return 'none';
}

/**
 * Evaluate candle integrity + freshness into a decision gate.
 * Pure (aside from optional counter side-effect when provider given).
 */
export function evaluateDataQualityDecision(
  input: DataQualityDecisionInput,
  opts: { recordCounters?: boolean } = {},
): DataQualityDecision {
  const issues = [...input.issues];
  if (input.incompleteCurrent) {
    issues.push({
      code: 'INCOMPLETE_CURRENT_CANDLE',
      message: 'Last candle is incomplete — actionable signals blocked',
    });
  }
  if (input.freshnessStatus === 'stale' || input.freshnessStatus === 'frozen') {
    issues.push({
      code: 'STALE_BENCHMARK',
      message: `Series freshness=${input.freshnessStatus}`,
    });
  }
  if (input.freshnessStatus === 'incomplete_current') {
    issues.push({
      code: 'INCOMPLETE_CURRENT_CANDLE',
      message: 'Freshness classifier: incomplete current candle',
    });
  }

  const codes = issues.map((i) => i.code);
  let severity = highestSeverity(codes);

  // Stale alone (without hard integrity fatals) → moderate / non-actionable
  if (
    severity === 'none' &&
    (input.freshnessStatus === 'stale' || input.freshnessStatus === 'frozen')
  ) {
    severity = 'moderate';
  }

  const rejectionReasons = issues
    .filter((i) => CRITICAL_CODES.has(i.code) || MODERATE_CODES.has(i.code))
    .map((i) => `${i.code}: ${i.message}`);
  const warnings = issues
    .filter((i) => MINOR_CODES.has(i.code))
    .map((i) => `${i.code}: ${i.message}`);

  const minorPts = input.minorModifierPts ?? 5;
  const confidenceCap = input.moderateConfidenceCap ?? 55;

  let score = 100;
  let scoreModifier = 0;
  let actionable = true;
  let rejectBeforeStrategies = false;

  if (severity === 'critical') {
    score = 0;
    scoreModifier = 0;
    actionable = false;
    rejectBeforeStrategies = true;
  } else if (severity === 'moderate') {
    score = Math.min(confidenceCap, 60);
    scoreModifier = 0; // cap applied at confidence site via confidenceCap
    actionable = false;
    rejectBeforeStrategies = false;
  } else if (severity === 'minor') {
    score = 100 - minorPts;
    scoreModifier = minorPts; // applied once at confidence site
    actionable = true;
  }

  const blockStructureStrategies = issues.some((i) => i.code === 'SPLIT_ANOMALY');

  if (opts.recordCounters && input.provider) {
    for (const r of rejectionReasons) {
      const reason = r.split(':')[0] ?? r;
      recordDataQualityRejection(reason, input.provider);
    }
  }

  return {
    score,
    severity,
    rejection_reasons: rejectionReasons,
    warnings,
    score_modifier: scoreModifier,
    actionable,
    rejectBeforeStrategies,
    blockStructureStrategies,
    // expose cap for callers applying moderate path
    ...(severity === 'moderate' ? {} : {}),
  };
}

/** Cap setup confidence once for moderate DQ (single influence point). */
export function applyDataQualityConfidenceModifier(
  confidenceFinalScore: number,
  decision: DataQualityDecision,
  moderateCap = 55,
): number {
  if (decision.severity === 'critical') return 0;
  if (decision.severity === 'moderate') {
    return Math.min(confidenceFinalScore, moderateCap);
  }
  if (decision.severity === 'minor' && decision.score_modifier > 0) {
    return Math.max(0, confidenceFinalScore - decision.score_modifier);
  }
  return confidenceFinalScore;
}
