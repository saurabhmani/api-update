// ════════════════════════════════════════════════════════════════
//  Signal Engine Integration Hooks
//
//  Phase 1 policy: the signal engine can QUERY manipulation state
//  but the engine itself does not yet apply penalties automatically.
//  These hooks return advisory data; wiring the penalty into the
//  actual signal scoring is a Phase 2 task (per spec §10).
// ════════════════════════════════════════════════════════════════

import type { ManipulationHookResult, ManipulationSnapshot } from '../types';
import { loadLatestSnapshot } from '../repository/persistence';
import { THRESHOLDS } from '../constants/thresholds';

/**
 * Build the hook result from a snapshot — pure function, unit-testable
 * without the database.
 */
export function buildHookResult(snapshot: ManipulationSnapshot | null, symbol: string): ManipulationHookResult {
  if (!snapshot) {
    return {
      symbol,
      snapshotDate: null,
      score: 0,
      band: 'low',
      shouldPenalize: false,
      shouldReject: false,
      warning: null,
      suggestedPenalty: 0,
      topEvents: [],
    };
  }

  const shouldPenalize = snapshot.manipulationScore >= THRESHOLDS.PENALTY_BAND_THRESHOLD;
  const shouldReject = snapshot.manipulationScore >= THRESHOLDS.REJECT_BAND_THRESHOLD;

  // Suggested penalty scales linearly from 0 at threshold to 25 at 100.
  const suggestedPenalty = shouldPenalize
    ? Math.round(((snapshot.manipulationScore - THRESHOLDS.PENALTY_BAND_THRESHOLD) /
        (100 - THRESHOLDS.PENALTY_BAND_THRESHOLD)) * 25)
    : 0;

  const warning = shouldReject
    ? `Severe manipulation suspicion (${snapshot.manipulationScore}/100): ${snapshot.explanation}`
    : shouldPenalize
      ? `Elevated manipulation suspicion (${snapshot.manipulationScore}/100): ${snapshot.explanation}`
      : null;

  const topEvents = snapshot.triggeredEvents
    .filter((e) => e.triggered)
    .slice()
    .sort((a, b) => b.detectorScore - a.detectorScore)
    .slice(0, 3)
    .map((e) => ({ eventType: e.eventType, severity: e.severity, label: e.detectorLabel }));

  return {
    symbol,
    snapshotDate: snapshot.snapshotDate,
    score: snapshot.manipulationScore,
    band: snapshot.suspicionBand,
    shouldPenalize,
    shouldReject,
    warning,
    suggestedPenalty,
    topEvents,
  };
}

/** DB-backed variant — the signal engine will call this at runtime. */
export async function getManipulationStatusForSymbol(symbol: string): Promise<ManipulationHookResult> {
  const snapshot = await loadLatestSnapshot(symbol);
  return buildHookResult(snapshot, symbol);
}

/** Shorthand accessors the engine may prefer. */
export async function shouldPenalizeSymbol(symbol: string): Promise<boolean> {
  return (await getManipulationStatusForSymbol(symbol)).shouldPenalize;
}

export async function shouldRejectSymbol(symbol: string): Promise<boolean> {
  return (await getManipulationStatusForSymbol(symbol)).shouldReject;
}

export async function getManipulationWarning(symbol: string): Promise<string | null> {
  return (await getManipulationStatusForSymbol(symbol)).warning;
}
