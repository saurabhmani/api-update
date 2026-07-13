// ════════════════════════════════════════════════════════════════
//  Phase 8 — Scenario Analysis (reports only)
// ════════════════════════════════════════════════════════════════

import type { PortfolioSnapshot } from '../engine/portfolioEngine';
import type { StressScenario } from '../types';

const SCENARIO_DEFS = [
  { scenarioId: 'market_crash', label: 'Market crash', shockPct: -20, sectorMultiplier: 1.0 },
  { scenarioId: 'sector_rotation', label: 'Sector rotation', shockPct: -8, sectorMultiplier: 1.5 },
  { scenarioId: 'volatility_spike', label: 'Volatility spike', shockPct: -12, sectorMultiplier: 0.8 },
  { scenarioId: 'currency_movement', label: 'Currency movement', shockPct: -5, sectorMultiplier: 0.5 },
  { scenarioId: 'interest_rate_shock', label: 'Interest rate shock', shockPct: -10, sectorMultiplier: 0.7 },
  { scenarioId: 'gap_risk', label: 'Gap risk', shockPct: -15, sectorMultiplier: 1.2 },
] as const;

export function runStressScenarios(snapshot: PortfolioSnapshot): StressScenario[] {
  const gross = snapshot.grossExposure || snapshot.capital || 1;

  return SCENARIO_DEFS.map((def) => {
    const sectorImpacts: Record<string, number> = {};
    let totalImpact = 0;

    for (const pos of snapshot.positions) {
      const signedShock = def.shockPct * def.sectorMultiplier * (pos.direction === 'long' ? 1 : -1);
      const impact = (pos.marketValue / gross) * signedShock;
      sectorImpacts[pos.sector] = (sectorImpacts[pos.sector] ?? 0) + impact;
      totalImpact += impact;
    }

  if (snapshot.positions.length === 0) {
    totalImpact = def.shockPct * 0.5;
  }

    return {
      scenarioId: def.scenarioId,
      label: def.label,
      shockPct: def.shockPct,
      portfolioImpactPct: Math.round(totalImpact * 100) / 100,
      sectorImpacts: Object.fromEntries(
        Object.entries(sectorImpacts).map(([k, v]) => [k, Math.round(v * 100) / 100]),
      ),
      explanation: `${def.label}: portfolio impact ${totalImpact.toFixed(1)}% under ${def.shockPct}% base shock`,
    };
  });
}

export function worstCaseScenario(scenarios: StressScenario[]): StressScenario | null {
  if (scenarios.length === 0) return null;
  return scenarios.reduce((worst, s) => (s.portfolioImpactPct < worst.portfolioImpactPct ? s : worst));
}
