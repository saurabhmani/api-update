// ════════════════════════════════════════════════════════════════
//  strategyScanHistogram — per-strategy counters for post-scan QA.
//
//  Aggregates evaluation / match / outcome stats across a single
//  Phase 3 universe pass. Reset at scan start, snapshot at scan end.
//  Do not tune thresholds until [POST_SCAN_SUMMARY] is available.
// ════════════════════════════════════════════════════════════════

import type { StrategyName } from '../types/signalEngine.types';
import type { SignalQualityStatus } from '../discovery/signalDiscoveryStatus';
import { STRATEGY_REGISTRY } from '../strategies/strategyRegistry';

export interface StrategyScanStats {
  strategy:            StrategyName;
  evaluated:           number;
  matched:             number;
  confirmed:           number;
  watchlist:           number;
  rejected:            number;
  averageFinalScore:   number | null;
  topRejectionReason:  string | null;
}

interface StrategyBucket {
  evaluated:           number;
  matched:             number;
  confirmed:           number;
  watchlist:           number;
  evaluationRejected:  number;
  outcomeRejected:     number;
  finalScoreSum:       number;
  finalScoreCount:     number;
  rejectionReasons:    Map<string, number>;
}

const buckets = new Map<StrategyName, StrategyBucket>();

function bucketFor(name: StrategyName): StrategyBucket {
  let b = buckets.get(name);
  if (!b) {
    b = {
      evaluated: 0,
      matched: 0,
      confirmed: 0,
      watchlist: 0,
      evaluationRejected: 0,
      outcomeRejected: 0,
      finalScoreSum: 0,
      finalScoreCount: 0,
      rejectionReasons: new Map(),
    };
    buckets.set(name, b);
  }
  return b;
}

function topReason(map: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [reason, n] of map) {
    if (n > bestN) {
      best = reason;
      bestN = n;
    }
  }
  return best;
}

export function resetStrategyScanHistogram(): void {
  buckets.clear();
}

/** One strategy evaluator invocation for a symbol. */
export function recordStrategyEvaluation(
  strategy: StrategyName,
  outcome: 'matched' | 'rejected',
  rejectionReason?: string | null,
): void {
  const b = bucketFor(strategy);
  b.evaluated++;
  if (outcome === 'matched') {
    b.matched++;
    return;
  }
  b.evaluationRejected++;
  const reason = String(rejectionReason ?? 'not_matched').trim() || 'not_matched';
  b.rejectionReasons.set(reason, (b.rejectionReasons.get(reason) ?? 0) + 1);
}

export interface StrategyOutcomeRecord {
  strategy:             StrategyName;
  signalQualityStatus:  SignalQualityStatus;
  technicalRejected:    boolean;
  finalScore:           number | null;
}

/** Final pipeline outcome for a strategy that produced a candidate row. */
export function recordStrategyOutcome(input: StrategyOutcomeRecord): void {
  const b = bucketFor(input.strategy);
  const fs = input.finalScore;
  if (fs != null && Number.isFinite(fs)) {
    b.finalScoreSum += fs;
    b.finalScoreCount++;
  }

  if (input.technicalRejected || input.signalQualityStatus === 'NO_TRADE') {
    b.outcomeRejected++;
    return;
  }
  if (input.signalQualityStatus === 'CONFIRMED_SIGNAL' || input.signalQualityStatus === 'HIGH_POTENTIAL') {
    b.confirmed++;
    return;
  }
  if (input.signalQualityStatus === 'WATCHLIST_ONLY' || input.signalQualityStatus === 'DEVELOPING_SETUP') {
    b.watchlist++;
    return;
  }
  b.outcomeRejected++;
}

export function snapshotStrategyScanHistogram(): StrategyScanStats[] {
  const names = new Set<StrategyName>([
    ...(Object.keys(STRATEGY_REGISTRY) as StrategyName[]),
    ...buckets.keys(),
  ]);

  return [...names]
    .sort()
    .map((strategy) => {
      const b = buckets.get(strategy);
      if (!b) {
        return {
          strategy,
          evaluated: 0,
          matched: 0,
          confirmed: 0,
          watchlist: 0,
          rejected: 0,
          averageFinalScore: null,
          topRejectionReason: null,
        };
      }
      return {
        strategy,
        evaluated:          b.evaluated,
        matched:            b.matched,
        confirmed:          b.confirmed,
        watchlist:          b.watchlist,
        rejected:           b.evaluationRejected + b.outcomeRejected,
        averageFinalScore:  b.finalScoreCount > 0
          ? Math.round((b.finalScoreSum / b.finalScoreCount) * 10) / 10
          : null,
        topRejectionReason: topReason(b.rejectionReasons),
      };
    })
    .filter((s) => s.evaluated > 0 || s.matched > 0 || s.confirmed > 0);
}
