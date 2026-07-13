// ════════════════════════════════════════════════════════════════
//  Phase 6 — Portfolio Context (reports only — no signal changes)
// ════════════════════════════════════════════════════════════════

import type { PortfolioContextReport } from './types';
import type { AssetClass } from './types';

export interface PortfolioPositionInput {
  symbol: string;
  assetClass: AssetClass;
  sector?: string | null;
  weight: number;
  direction: 'long' | 'short';
}

export function buildPortfolioContextReport(input: {
  positions: readonly PortfolioPositionInput[];
  correlationMatrix?: Record<string, Record<string, number>>;
  generatedAt?: string;
}): PortfolioContextReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sectorExposure: Record<string, number> = {};
  const assetExposure: Record<string, number> = {};
  const allocationSummary: Record<string, number> = {};

  for (const pos of input.positions) {
    const signed = pos.direction === 'short' ? -pos.weight : pos.weight;
    const sector = pos.sector ?? 'unknown';
    sectorExposure[sector] = (sectorExposure[sector] ?? 0) + signed;
    assetExposure[pos.assetClass] = (assetExposure[pos.assetClass] ?? 0) + signed;
    allocationSummary[pos.symbol] = (allocationSummary[pos.symbol] ?? 0) + signed;
  }

  const correlationSummary: PortfolioContextReport['correlationSummary'] = [];
  if (input.correlationMatrix) {
    const keys = Object.keys(input.correlationMatrix);
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = keys[i];
        const b = keys[j];
        correlationSummary.push({
          pair: `${a}/${b}`,
          correlation: input.correlationMatrix[a]?.[b] ?? 0,
        });
      }
    }
  }

  const weights = Object.values(allocationSummary).map(Math.abs);
  const total = weights.reduce((s, v) => s + v, 0) || 1;
  const hhi = weights.reduce((s, w) => s + (w / total) ** 2, 0);
  const concentrationScore = Math.round(hhi * 10000) / 10000;

  return {
    generatedAt,
    sectorExposure,
    assetExposure,
    correlationSummary,
    concentrationScore,
    allocationSummary,
  };
}
