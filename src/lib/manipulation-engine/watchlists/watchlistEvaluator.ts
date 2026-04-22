// ════════════════════════════════════════════════════════════════
//  Phase 3 — Watchlist Evaluator
//
//  Pure function: given a snapshot + the current watchlist state for a
//  symbol, return the changes that should be applied. Persistence is
//  the caller's job — keeping I/O outside makes this trivially testable
//  and lets the same function run inside backtests.
//
//  Three watchlists with different add/remove rules:
//
//   1. suspicious_symbols   — any snapshot ≥ elevated → add. Removed
//                              after a 5-day cooling-off below watch.
//   2. high_risk_operator   — any snapshot with closeRamp OR pumpRisk
//                              detector triggered AND score ≥ high.
//                              Cooling-off 10 days.
//   3. event_cluster        — anomalyDensity20d ≥ 0.30. Cooling-off 5d.
// ════════════════════════════════════════════════════════════════

import type {
  ManipulationSnapshot, WatchlistType, WatchlistChangeType, SuspicionBand,
  WatchlistEntry,
} from '../types';

export interface WatchlistDecision {
  watchlistType: WatchlistType;
  /** Should the symbol be on this list right now? */
  shouldBeListed: boolean;
  /** Days of cooling-off if the symbol is already listed but no longer qualifies. */
  coolingOffDays: number;
  reason: string;
}

export interface WatchlistChange {
  symbol: string;
  watchlistType: WatchlistType;
  changeType: WatchlistChangeType;
  score: number | null;
  band: SuspicionBand | null;
  reason: string;
}

const COOLING_OFF: Record<WatchlistType, number> = {
  suspicious_symbols: 5,
  high_risk_operator: 10,
  event_cluster: 5,
};

/**
 * Evaluate one snapshot against the three watchlists. Pure — no DB.
 * Returns the list of decisions for the snapshot's symbol; the caller
 * compares against current state and persists deltas.
 */
export function evaluateWatchlists(snapshot: ManipulationSnapshot): WatchlistDecision[] {
  const decisions: WatchlistDecision[] = [];

  // 1. suspicious_symbols
  const suspiciousQualifies =
    snapshot.suspicionBand === 'elevated' ||
    snapshot.suspicionBand === 'high' ||
    snapshot.suspicionBand === 'severe';
  decisions.push({
    watchlistType: 'suspicious_symbols',
    shouldBeListed: suspiciousQualifies,
    coolingOffDays: COOLING_OFF.suspicious_symbols,
    reason: suspiciousQualifies
      ? `Score ${snapshot.manipulationScore} (${snapshot.suspicionBand})`
      : 'Below elevated band',
  });

  // 2. high_risk_operator
  const operatorDetectors = snapshot.triggeredEvents.filter(
    (e) =>
      e.triggered &&
      (e.detectorName === 'closeRamp' ||
        e.detectorName === 'pumpRisk' ||
        e.detectorName === 'illiquidMarking'),
  );
  const operatorQualifies =
    operatorDetectors.length > 0 &&
    (snapshot.suspicionBand === 'high' || snapshot.suspicionBand === 'severe');
  decisions.push({
    watchlistType: 'high_risk_operator',
    shouldBeListed: operatorQualifies,
    coolingOffDays: COOLING_OFF.high_risk_operator,
    reason: operatorQualifies
      ? `Operator-style detectors active: ${operatorDetectors.map((d) => d.detectorName).join(', ')}`
      : 'No operator-style pattern at high band',
  });

  // 3. event_cluster
  const clusterQualifies =
    (snapshot.features?.anomalyDensity20d ?? 0) >= 0.3 ||
    (snapshot.features?.eventClusterCount ?? 0) >= 6;
  decisions.push({
    watchlistType: 'event_cluster',
    shouldBeListed: clusterQualifies,
    coolingOffDays: COOLING_OFF.event_cluster,
    reason: clusterQualifies
      ? `Anomaly density ${(snapshot.features?.anomalyDensity20d ?? 0).toFixed(2)}, cluster count ${snapshot.features?.eventClusterCount ?? 0}`
      : 'Anomaly density below threshold',
  });

  return decisions;
}

/**
 * Diff a list of decisions against the current persisted entries to
 * produce a minimal set of changes. Pure — caller persists the result.
 */
export function diffWatchlistState(
  snapshot: ManipulationSnapshot,
  decisions: WatchlistDecision[],
  currentEntries: WatchlistEntry[],
  asOfDate: string = snapshot.snapshotDate,
): WatchlistChange[] {
  const changes: WatchlistChange[] = [];
  const byType = new Map(currentEntries.map((e) => [e.watchlistType, e]));

  for (const d of decisions) {
    const existing = byType.get(d.watchlistType);
    if (d.shouldBeListed) {
      if (!existing) {
        changes.push({
          symbol: snapshot.symbol,
          watchlistType: d.watchlistType,
          changeType: 'added',
          score: snapshot.manipulationScore,
          band: snapshot.suspicionBand,
          reason: d.reason,
        });
      } else {
        // Refresh the entry's reason/score (no removal)
        changes.push({
          symbol: snapshot.symbol,
          watchlistType: d.watchlistType,
          changeType: 'refreshed',
          score: snapshot.manipulationScore,
          band: snapshot.suspicionBand,
          reason: d.reason,
        });
      }
    } else if (existing) {
      // Symbol no longer qualifies — start cooling-off if not already.
      if (!existing.coolingOffUntil) {
        const until = new Date(asOfDate);
        until.setUTCDate(until.getUTCDate() + d.coolingOffDays);
        changes.push({
          symbol: snapshot.symbol,
          watchlistType: d.watchlistType,
          changeType: 'downgraded',
          score: snapshot.manipulationScore,
          band: snapshot.suspicionBand,
          reason: `Cooling-off until ${until.toISOString().split('T')[0]}: ${d.reason}`,
        });
      } else if (asOfDate > existing.coolingOffUntil) {
        // Cooling-off expired — remove.
        changes.push({
          symbol: snapshot.symbol,
          watchlistType: d.watchlistType,
          changeType: 'removed',
          score: snapshot.manipulationScore,
          band: snapshot.suspicionBand,
          reason: `Cooling-off expired (${existing.coolingOffUntil})`,
        });
      }
    }
  }
  return changes;
}
