// ════════════════════════════════════════════════════════════════
//  Phase 6 — Strategy health governance
//
//  States are versioned and auditable. Historical strategy records
//  are never deleted — health only governs publishing eligibility.
// ════════════════════════════════════════════════════════════════

import type { StrategyName } from '../types/signalEngine.types';

export const STRATEGY_HEALTH_MODEL_VERSION = '6.0.0';

export type StrategyHealthState =
  | 'Active'
  | 'Watch'
  | 'Restricted'
  | 'Research-only'
  | 'Retired';

export interface StrategyHealthSnapshot {
  strategy: StrategyName;
  state: StrategyHealthState;
  reason: string;
  /** OOS sample size when assessed. */
  sampleSize: number;
  winRate: number | null;
  avgPnlR: number | null;
  modelVersion: string;
  assessedAt: string;
  /** Monotonic version for audit trail. */
  version: number;
}

export interface StrategyPerformanceInput {
  strategy: StrategyName;
  sampleSize: number;
  winRate: number; // 0–1
  avgPnlR: number;
  /** Optional calibration / expectancy flags. */
  calibrationDeteriorated?: boolean;
  sampleQualityPoor?: boolean;
}

/** In-process health ledger (append-only versions). */
const HEALTH_LEDGER: StrategyHealthSnapshot[] = [];

/**
 * Derive health from OOS performance snapshots.
 * Restricted when OOS performance, calibration, or sample quality deteriorates.
 */
export function assessStrategyHealth(
  input: StrategyPerformanceInput,
  previous?: StrategyHealthSnapshot | null,
): StrategyHealthSnapshot {
  const assessedAt = new Date().toISOString();
  const version = (previous?.version ?? 0) + 1;

  let state: StrategyHealthState = 'Active';
  let reason = 'OOS metrics within healthy band';

  if (input.sampleSize < 20) {
    state = 'Watch';
    reason = `Insufficient OOS sample (n=${input.sampleSize} < 20)`;
  } else if (input.sampleQualityPoor) {
    state = 'Restricted';
    reason = 'Sample quality deteriorated — publishing restricted';
  } else if (input.calibrationDeteriorated) {
    state = 'Restricted';
    reason = 'Calibration deteriorated out-of-sample';
  } else if (input.avgPnlR < -0.15 && input.winRate < 0.4) {
    state = 'Restricted';
    reason = `Weak expectancy (win=${(input.winRate * 100).toFixed(0)}%, avgR=${input.avgPnlR})`;
  } else if (input.avgPnlR < 0 || input.winRate < 0.42) {
    state = 'Watch';
    reason = `Soft deterioration (win=${(input.winRate * 100).toFixed(0)}%, avgR=${input.avgPnlR})`;
  }

  // Never auto-delete; Research-only / Retired only via explicit operator event
  if (previous?.state === 'Retired') {
    state = 'Retired';
    reason = previous.reason;
  } else if (previous?.state === 'Research-only' && state === 'Active') {
    state = 'Research-only';
    reason = previous.reason;
  }

  const snap: StrategyHealthSnapshot = {
    strategy: input.strategy,
    state,
    reason,
    sampleSize: input.sampleSize,
    winRate: input.winRate,
    avgPnlR: input.avgPnlR,
    modelVersion: STRATEGY_HEALTH_MODEL_VERSION,
    assessedAt,
    version,
  };
  HEALTH_LEDGER.push(snap);
  return snap;
}

export function setStrategyHealthManual(
  strategy: StrategyName,
  state: StrategyHealthState,
  reason: string,
  previous?: StrategyHealthSnapshot | null,
): StrategyHealthSnapshot {
  const snap: StrategyHealthSnapshot = {
    strategy,
    state,
    reason,
    sampleSize: previous?.sampleSize ?? 0,
    winRate: previous?.winRate ?? null,
    avgPnlR: previous?.avgPnlR ?? null,
    modelVersion: STRATEGY_HEALTH_MODEL_VERSION,
    assessedAt: new Date().toISOString(),
    version: (previous?.version ?? 0) + 1,
  };
  HEALTH_LEDGER.push(snap);
  return snap;
}

export function getLatestStrategyHealth(strategy: StrategyName): StrategyHealthSnapshot | null {
  for (let i = HEALTH_LEDGER.length - 1; i >= 0; i--) {
    if (HEALTH_LEDGER[i].strategy === strategy) return HEALTH_LEDGER[i];
  }
  return null;
}

export function getStrategyHealthHistory(strategy: StrategyName): StrategyHealthSnapshot[] {
  return HEALTH_LEDGER.filter((h) => h.strategy === strategy);
}

/** Publishing eligibility — does not delete history. */
export function isStrategyPublishable(state: StrategyHealthState): {
  allowConfirmed: boolean;
  allowWatchlist: boolean;
  reason: string | null;
} {
  switch (state) {
    case 'Active':
      return { allowConfirmed: true, allowWatchlist: true, reason: null };
    case 'Watch':
      return { allowConfirmed: true, allowWatchlist: true, reason: 'Strategy on Watch — extra scrutiny' };
    case 'Restricted':
      return {
        allowConfirmed: false,
        allowWatchlist: true,
        reason: 'Strategy Restricted — confirmed signals blocked',
      };
    case 'Research-only':
      return {
        allowConfirmed: false,
        allowWatchlist: false,
        reason: 'Strategy Research-only — not published',
      };
    case 'Retired':
      return {
        allowConfirmed: false,
        allowWatchlist: false,
        reason: 'Strategy Retired — historical records retained',
      };
  }
}

/** Test helper — clear in-memory ledger. */
export function __resetStrategyHealthLedgerForTests(): void {
  HEALTH_LEDGER.length = 0;
}
