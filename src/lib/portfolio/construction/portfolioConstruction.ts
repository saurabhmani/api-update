// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Construction
// ════════════════════════════════════════════════════════════════

import type { AllocationConstraints, AllocationMethod, AllocationPlan, ConsumableSignal } from '../types';

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  if (total <= 0) return weights;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    out[k] = Math.round((v / total) * 10000) / 10000;
  }
  return out;
}

function applyMaxExposure(weights: Record<string, number>, maxPct: number): Record<string, number> {
  const cap = maxPct / 100;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights)) {
    out[k] = Math.min(v, cap);
  }
  return normalizeWeights(out);
}

export function buildEqualWeightAllocation(symbols: string[]): AllocationPlan {
  const w = 1 / Math.max(symbols.length, 1);
  const weights = Object.fromEntries(symbols.map((s) => [s, w]));
  return {
    method: 'equal_weight',
    weights,
    constraints: defaultConstraints(),
    explanation: `Equal weight across ${symbols.length} symbols (${(w * 100).toFixed(1)}% each)`,
  };
}

export function buildRiskParityAllocation(
  symbols: string[],
  volatilities: Record<string, number>,
): AllocationPlan {
  const invVol = symbols.map((s) => 1 / Math.max(volatilities[s] ?? 0.2, 0.01));
  const total = invVol.reduce((s, v) => s + v, 0);
  const weights = Object.fromEntries(symbols.map((s, i) => [s, invVol[i] / total]));
  return {
    method: 'risk_parity',
    weights: normalizeWeights(weights),
    constraints: defaultConstraints(),
    explanation: 'Risk parity: inverse-volatility weighting',
  };
}

export function buildVolatilityTargetingAllocation(
  symbols: string[],
  volatilities: Record<string, number>,
  targetVolPct: number,
): AllocationPlan {
  const avgVol = symbols.reduce((s, sym) => s + (volatilities[sym] ?? 0.2), 0) / Math.max(symbols.length, 1);
  const scale = targetVolPct / (avgVol * 100);
  const base = buildEqualWeightAllocation(symbols);
  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(base.weights)) {
    weights[k] = v * Math.min(scale, 1);
  }
  return {
    method: 'volatility_targeting',
    weights: normalizeWeights(weights),
    constraints: { ...defaultConstraints(), targetVolatilityPct: targetVolPct },
    explanation: `Volatility targeting at ${targetVolPct}% annualized`,
  };
}

export function buildSectorBalancingAllocation(signals: ConsumableSignal[]): AllocationPlan {
  const sectors = new Map<string, string[]>();
  for (const s of signals) {
    const list = sectors.get(s.sector) ?? [];
    list.push(s.symbol);
    sectors.set(s.sector, list);
  }
  const sectorWeight = 1 / Math.max(sectors.size, 1);
  const weights: Record<string, number> = {};
  for (const [, syms] of sectors) {
    const symWeight = sectorWeight / syms.length;
    for (const sym of syms) weights[sym] = symWeight;
  }
  return {
    method: 'sector_balancing',
    weights: normalizeWeights(weights),
    constraints: defaultConstraints(),
    explanation: `Sector-balanced across ${sectors.size} sectors`,
  };
}

export function buildMarketCapWeightingAllocation(
  symbols: string[],
  marketCaps: Record<string, number>,
): AllocationPlan {
  const total = symbols.reduce((s, sym) => s + (marketCaps[sym] ?? 1), 0);
  const weights = Object.fromEntries(
    symbols.map((s) => [s, (marketCaps[s] ?? 1) / total]),
  );
  return {
    method: 'market_cap_weighting',
    weights: normalizeWeights(weights),
    constraints: defaultConstraints(),
    explanation: 'Market-cap weighted allocation',
  };
}

export function buildCustomAllocation(
  weights: Record<string, number>,
  constraints?: Partial<AllocationConstraints>,
): AllocationPlan {
  const c = { ...defaultConstraints(), ...constraints };
  return {
    method: 'custom',
    weights: applyMaxExposure(normalizeWeights(weights), c.maxSinglePositionPct),
    constraints: c,
    explanation: 'Custom allocation with maximum exposure constraints applied',
  };
}

export function constructPortfolioAllocation(
  method: AllocationMethod,
  signals: ConsumableSignal[],
  options?: {
    volatilities?: Record<string, number>;
    marketCaps?: Record<string, number>;
    targetVolPct?: number;
    customWeights?: Record<string, number>;
    constraints?: Partial<AllocationConstraints>;
  },
): AllocationPlan {
  const symbols = [...new Set(signals.map((s) => s.symbol))];
  switch (method) {
    case 'equal_weight':
      return buildEqualWeightAllocation(symbols);
    case 'risk_parity':
      return buildRiskParityAllocation(symbols, options?.volatilities ?? {});
    case 'volatility_targeting':
      return buildVolatilityTargetingAllocation(symbols, options?.volatilities ?? {}, options?.targetVolPct ?? 12);
    case 'sector_balancing':
      return buildSectorBalancingAllocation(signals);
    case 'market_cap_weighting':
      return buildMarketCapWeightingAllocation(symbols, options?.marketCaps ?? {});
    case 'custom':
      return buildCustomAllocation(options?.customWeights ?? buildEqualWeightAllocation(symbols).weights, options?.constraints);
    default:
      return buildEqualWeightAllocation(symbols);
  }
}

function defaultConstraints(): AllocationConstraints {
  return {
    maxSinglePositionPct: 10,
    maxSectorExposurePct: 30,
    maxGrossExposurePct: 100,
    maxCountryExposurePct: 80,
    maxCurrencyExposurePct: 90,
  };
}
