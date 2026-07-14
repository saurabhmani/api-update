// ════════════════════════════════════════════════════════════════
//  Historical Regime Performance Report — Product A Phase 3
// ════════════════════════════════════════════════════════════════

import type { RegimeTransitionState, MarketRegimeLabel } from '../types/signalEngine.types';

export interface RegimePerformanceOutcomeRow {
  strategy: string;
  regimeLabel: MarketRegimeLabel | string;
  transitionState?: RegimeTransitionState | string | null;
  target1Hit: boolean;
  pnlR?: number;
}

export interface RegimePerformanceCell {
  strategy: string;
  regimeLabel: string;
  transitionState: string;
  sampleSize: number;
  winRate: number;
  avgPnlR: number;
}

export interface RegimePerformanceReport {
  generatedAt: string;
  cells: RegimePerformanceCell[];
  byRegime: Array<{ regimeLabel: string; sampleSize: number; winRate: number; avgPnlR: number }>;
  byTransition: Array<{ transitionState: string; sampleSize: number; winRate: number; avgPnlR: number }>;
}

function aggregate(
  rows: RegimePerformanceOutcomeRow[],
  keyFn: (r: RegimePerformanceOutcomeRow) => string,
): Map<string, { wins: number; n: number; pnl: number }> {
  const map = new Map<string, { wins: number; n: number; pnl: number }>();
  for (const r of rows) {
    const k = keyFn(r);
    const cell = map.get(k) ?? { wins: 0, n: 0, pnl: 0 };
    cell.n++;
    if (r.target1Hit) cell.wins++;
    cell.pnl += r.pnlR ?? 0;
    map.set(k, cell);
  }
  return map;
}

/** Strategy performance measurable by regime label and transition state. */
export function buildRegimePerformanceReport(
  outcomes: RegimePerformanceOutcomeRow[],
  generatedAt = new Date().toISOString(),
): RegimePerformanceReport {
  const cellsMap = aggregate(
    outcomes,
    (r) => `${r.strategy}|${r.regimeLabel}|${r.transitionState ?? 'unknown'}`,
  );
  const cells: RegimePerformanceCell[] = [];
  for (const [k, v] of cellsMap) {
    const [strategy, regimeLabel, transitionState] = k.split('|');
    cells.push({
      strategy,
      regimeLabel,
      transitionState,
      sampleSize: v.n,
      winRate: v.n === 0 ? 0 : Math.round((v.wins / v.n) * 10000) / 10000,
      avgPnlR: v.n === 0 ? 0 : Math.round((v.pnl / v.n) * 10000) / 10000,
    });
  }
  cells.sort((a, b) => b.sampleSize - a.sampleSize);

  const byRegimeMap = aggregate(outcomes, (r) => String(r.regimeLabel));
  const byRegime = Array.from(byRegimeMap.entries()).map(([regimeLabel, v]) => ({
    regimeLabel,
    sampleSize: v.n,
    winRate: v.n === 0 ? 0 : Math.round((v.wins / v.n) * 10000) / 10000,
    avgPnlR: v.n === 0 ? 0 : Math.round((v.pnl / v.n) * 10000) / 10000,
  }));

  const byTransitionMap = aggregate(outcomes, (r) => String(r.transitionState ?? 'unknown'));
  const byTransition = Array.from(byTransitionMap.entries()).map(([transitionState, v]) => ({
    transitionState,
    sampleSize: v.n,
    winRate: v.n === 0 ? 0 : Math.round((v.wins / v.n) * 10000) / 10000,
    avgPnlR: v.n === 0 ? 0 : Math.round((v.pnl / v.n) * 10000) / 10000,
  }));

  return { generatedAt, cells, byRegime, byTransition };
}
