// ════════════════════════════════════════════════════════════════
//  Phase 8 — Signal Prioritization
//  Uses existing Product A confidence — does not modify it.
// ════════════════════════════════════════════════════════════════

import type { ConsumableSignal, PrioritizedSignal } from '../types';
import type { PortfolioSnapshot } from '../engine/portfolioEngine';

export interface PrioritizationConfig {
  maxSectorExposurePct: number;
  maxSinglePositionPct: number;
  minLiquidityScore: number;
  maxSignals: number;
}

const DEFAULT_CONFIG: PrioritizationConfig = {
  maxSectorExposurePct: 30,
  maxSinglePositionPct: 10,
  minLiquidityScore: 40,
  maxSignals: 20,
};

export function prioritizeSignals(
  signals: ConsumableSignal[],
  snapshot: PortfolioSnapshot,
  config: Partial<PrioritizationConfig> = {},
): PrioritizedSignal[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const existingSymbols = new Set(snapshot.positions.map((p) => p.symbol));
  const sectorExposure = { ...snapshot.sectorAllocations };

  const scored = signals.map((signal) => {
    const rejectionReasons: string[] = [];
    let priorityScore = signal.confidenceScore * 0.4 + signal.finalScore * 0.3 + signal.portfolioFitScore * 0.3;

    // Existing confidence is read-only — used as-is
    if (signal.liquidityScore < cfg.minLiquidityScore) {
      rejectionReasons.push(`Liquidity ${signal.liquidityScore} below minimum ${cfg.minLiquidityScore}`);
      priorityScore -= 20;
    }

    const projectedSector = (sectorExposure[signal.sector] ?? 0) + (signal.recommendedCapital / snapshot.capital);
    if (projectedSector * 100 > cfg.maxSectorExposurePct) {
      rejectionReasons.push(`Sector ${signal.sector} exposure would exceed ${cfg.maxSectorExposurePct}%`);
      priorityScore -= 25;
    }

    const projectedPosition = signal.recommendedCapital / snapshot.capital;
    if (projectedPosition * 100 > cfg.maxSinglePositionPct) {
      rejectionReasons.push(`Position size would exceed ${cfg.maxSinglePositionPct}%`);
      priorityScore -= 15;
    }

    if (signal.recommendedCapital > snapshot.availableBuyingPower) {
      rejectionReasons.push('Insufficient available capital');
      priorityScore -= 30;
    }

    if (existingSymbols.has(signal.symbol)) {
      rejectionReasons.push('Existing position — correlation/overlap risk');
      priorityScore -= 10;
    }

    // Correlation proxy: penalize same-sector clustering
    const sameSectorCount = snapshot.positions.filter((p) => p.sector === signal.sector).length;
    if (sameSectorCount >= 2) {
      priorityScore -= sameSectorCount * 3;
      rejectionReasons.push(`Sector cluster: ${sameSectorCount} existing positions in ${signal.sector}`);
    }

    const selected = rejectionReasons.length === 0 || priorityScore >= 50;
    const explanation = selected
      ? `Selected: confidence=${signal.confidenceScore}, fit=${signal.portfolioFitScore}, priority=${priorityScore.toFixed(1)}`
      : `Rejected: ${rejectionReasons.join('; ')}`;

    return {
      signal,
      priorityScore: Math.round(priorityScore * 100) / 100,
      rank: 0,
      selected,
      rejectionReasons,
      explanation,
    };
  });

  const ranked = scored
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, cfg.maxSignals)
    .map((s, i) => ({ ...s, rank: i + 1 }));

  // Mark top signals as selected up to capital budget
  let capitalUsed = 0;
  return ranked.map((item) => {
    if (!item.selected) return item;
    const needed = item.signal.recommendedCapital;
    if (capitalUsed + needed > snapshot.availableBuyingPower) {
      return {
        ...item,
        selected: false,
        rejectionReasons: [...item.rejectionReasons, 'Capital budget exhausted'],
        explanation: `Rejected: capital budget exhausted after ${capitalUsed.toFixed(0)} deployed`,
      };
    }
    capitalUsed += needed;
    return item;
  });
}
