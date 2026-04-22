// ════════════════════════════════════════════════════════════════
//  Drawdown Metrics — Risk analysis from equity curve
// ════════════════════════════════════════════════════════════════

import type { EquityPoint } from '../types';

export interface DrawdownStats {
  maxDrawdownPct: number;
  maxDrawdownDuration: number;         // bars
  maxDrawdownRecovery: number | null;  // bars to recover (null if not yet recovered)
  avgDrawdownPct: number;
  drawdownFrequency: number;           // how many distinct drawdown periods
  currentDrawdownPct: number;
  /** Longest time underwater (below previous peak) */
  longestUnderwaterDays: number;
  /** All significant drawdowns (> 2%) */
  significantDrawdowns: DrawdownPeriod[];
}

export interface DrawdownPeriod {
  startDate: string;
  troughDate: string;
  endDate: string | null;   // null if not recovered
  peakEquity: number;
  troughEquity: number;
  drawdownPct: number;
  durationBars: number;
  recoveryBars: number | null;
}

export function computeDrawdownStats(curve: EquityPoint[]): DrawdownStats {
  if (curve.length === 0) return emptyDrawdown();

  let peak = curve[0].equity;
  let maxDdPct = 0;
  let maxDdDuration = 0;

  // Track all drawdown periods
  const periods: DrawdownPeriod[] = [];
  let currentPeriod: DrawdownPeriod | null = null;
  let underwaterStart = -1;
  let longestUnderwater = 0;

  const ddValues: number[] = [];

  for (let i = 0; i < curve.length; i++) {
    const eq = curve[i].equity;

    if (eq >= peak) {
      // New high — close any open drawdown period
      if (currentPeriod) {
        currentPeriod.endDate = curve[i].date;
        currentPeriod.recoveryBars = i - (underwaterStart >= 0 ? underwaterStart : i);
        if (currentPeriod.drawdownPct >= 2) periods.push(currentPeriod);
        currentPeriod = null;
      }
      if (underwaterStart >= 0) {
        longestUnderwater = Math.max(longestUnderwater, i - underwaterStart);
        underwaterStart = -1;
      }
      peak = eq;
    } else {
      const ddPct = ((peak - eq) / peak) * 100;
      ddValues.push(ddPct);

      if (underwaterStart < 0) underwaterStart = i;

      if (!currentPeriod) {
        currentPeriod = {
          startDate: curve[Math.max(0, i - 1)].date,
          troughDate: curve[i].date,
          endDate: null,
          peakEquity: peak,
          troughEquity: eq,
          drawdownPct: ddPct,
          durationBars: 1,
          recoveryBars: null,
        };
      } else {
        currentPeriod.durationBars++;
        if (ddPct > currentPeriod.drawdownPct) {
          currentPeriod.drawdownPct = ddPct;
          currentPeriod.troughEquity = eq;
          currentPeriod.troughDate = curve[i].date;
        }
      }

      if (ddPct > maxDdPct) {
        maxDdPct = ddPct;
        maxDdDuration = currentPeriod.durationBars;
      }
    }
  }

  // Handle unclosed drawdown
  if (currentPeriod && currentPeriod.drawdownPct >= 2) periods.push(currentPeriod);
  if (underwaterStart >= 0) {
    longestUnderwater = Math.max(longestUnderwater, curve.length - underwaterStart);
  }

  const avgDd = ddValues.length > 0 ? ddValues.reduce((s, v) => s + v, 0) / ddValues.length : 0;
  const currentDd = curve[curve.length - 1].drawdownPct;

  return {
    maxDrawdownPct: r(maxDdPct),
    maxDrawdownDuration: maxDdDuration,
    maxDrawdownRecovery: periods.length > 0 ? periods[0].recoveryBars : null,
    avgDrawdownPct: r(avgDd),
    drawdownFrequency: periods.length,
    currentDrawdownPct: r(currentDd),
    longestUnderwaterDays: longestUnderwater,
    significantDrawdowns: periods.map(p => ({
      ...p, drawdownPct: r(p.drawdownPct), peakEquity: r(p.peakEquity), troughEquity: r(p.troughEquity),
    })).sort((a, b) => b.drawdownPct - a.drawdownPct),
  };
}

function emptyDrawdown(): DrawdownStats {
  return {
    maxDrawdownPct: 0, maxDrawdownDuration: 0, maxDrawdownRecovery: null,
    avgDrawdownPct: 0, drawdownFrequency: 0, currentDrawdownPct: 0,
    longestUnderwaterDays: 0, significantDrawdowns: [],
  };
}

function r(v: number): number { return Math.round(v * 100) / 100; }
