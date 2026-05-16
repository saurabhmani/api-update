// ════════════════════════════════════════════════════════════════
//  Phase 3 — Backtest Signal Tagger
//
//  Pure utilities used by the backtest runner to:
//   1. compute the manipulation snapshot a signal would have seen at
//      its signal date (using only bars ≤ that date — point-in-time
//      safe), and
//   2. decide whether the signal should be excluded from the run by
//      the manipulation filter.
//
//  Pure functions only; the runner orchestrates DB I/O around them.
// ════════════════════════════════════════════════════════════════

import type { DailyBar, ManipulationSnapshot, SuspicionBand } from '../types';
import { scanSymbol } from '../pipeline/runScan';

export interface BacktestTag {
  manipulationScore: number;
  manipulationBand: SuspicionBand;
  excluded: boolean;
}

/**
 * Build a manipulation tag for a signal at `signalDate` from a bar
 * history. The bars must already be sorted ascending — the helper
 * trims to bars ≤ signalDate to keep the scan point-in-time safe.
 */
export function buildBacktestTag(
  symbol: string,
  bars: DailyBar[],
  signalDate: string,
  filterScore: number | undefined,
): BacktestTag | null {
  const eligible = bars.filter((b) => b.date <= signalDate);
  if (eligible.length < 5) return null;
  const snap = scanSymbol(symbol, eligible);
  if (!snap) return null;
  const excluded = filterScore != null && snap.manipulationScore >= filterScore;
  return {
    manipulationScore: snap.manipulationScore,
    manipulationBand: snap.suspicionBand,
    excluded,
  };
}

/**
 * Convert a snapshot directly into a tag (used when the caller already
 * has the snapshot from the persisted store).
 */
export function tagFromSnapshot(
  snap: ManipulationSnapshot,
  filterScore: number | undefined,
): BacktestTag {
  return {
    manipulationScore: snap.manipulationScore,
    manipulationBand: snap.suspicionBand,
    excluded: filterScore != null && snap.manipulationScore >= filterScore,
  };
}
