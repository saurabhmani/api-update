// ════════════════════════════════════════════════════════════════
//  Phase 8 — Institutional Risk Engine
// ════════════════════════════════════════════════════════════════

import type { PortfolioPosition, RiskMetrics } from '../types';
import type { PortfolioSnapshot } from '../engine/portfolioEngine';

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

export function buildCorrelationMatrix(
  returnsBySymbol: Record<string, number[]>,
): Record<string, Record<string, number>> {
  const symbols = Object.keys(returnsBySymbol);
  const matrix: Record<string, Record<string, number>> = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      matrix[a][b] = a === b ? 1 : pearson(returnsBySymbol[a], returnsBySymbol[b]);
    }
  }
  return matrix;
}

export function computeExposureBreakdown(positions: PortfolioPosition[]): {
  sector: Record<string, number>;
  country: Record<string, number>;
  currency: Record<string, number>;
} {
  const sector: Record<string, number> = {};
  const country: Record<string, number> = {};
  const currency: Record<string, number> = {};
  const total = positions.reduce((s, p) => s + Math.abs(p.marketValue), 0) || 1;

  for (const p of positions) {
    const w = Math.abs(p.marketValue) / total;
    sector[p.sector] = (sector[p.sector] ?? 0) + w;
    country[p.country] = (country[p.country] ?? 0) + w;
    currency[p.currency] = (currency[p.currency] ?? 0) + w;
  }
  return { sector, country, currency };
}

export function computeConcentrationHhi(weights: number[]): number {
  const total = weights.reduce((s, v) => s + v, 0) || 1;
  return weights.reduce((s, w) => s + (w / total) ** 2, 0);
}

export function computeVaR(returns: number[], confidence = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * sorted.length);
  return Math.abs(sorted[Math.max(0, idx)] ?? 0);
}

export function computeCVaR(returns: number[], confidence = 0.95): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.floor((1 - confidence) * sorted.length);
  const tail = sorted.slice(0, Math.max(1, cutoff));
  return Math.abs(mean(tail));
}

export function computeMaxDrawdown(equityCurve: number[]): number {
  let peak = equityCurve[0] ?? 1;
  let maxDd = 0;
  for (const v of equityCurve) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  return maxDd;
}

export function computePortfolioRiskMetrics(input: {
  snapshot: PortfolioSnapshot;
  returns?: number[];
  benchmarkReturns?: number[];
  returnsBySymbol?: Record<string, number[]>;
  equityCurve?: number[];
}): RiskMetrics {
  const returns = input.returns ?? [];
  const portfolioVolatility = std(returns) * Math.sqrt(252);
  const valueAtRisk95 = computeVaR(returns, 0.95);
  const conditionalVaR95 = computeCVaR(returns, 0.95);
  const maxDrawdown = computeMaxDrawdown(input.equityCurve ?? [input.snapshot.capital]);
  const benchmark = input.benchmarkReturns ?? [];
  const beta = benchmark.length >= 2 && returns.length >= 2
    ? pearson(returns, benchmark) * (std(returns) / Math.max(std(benchmark), 1e-9))
    : 1;

  const exposures = computeExposureBreakdown(input.snapshot.positions);
  const weights = input.snapshot.positions.map((p) => Math.abs(p.weight));
  const correlationMatrix = input.returnsBySymbol
    ? buildCorrelationMatrix(input.returnsBySymbol)
    : {};

  return {
    portfolioVolatility: Math.round(portfolioVolatility * 10000) / 10000,
    valueAtRisk95: Math.round(valueAtRisk95 * 10000) / 10000,
    conditionalVaR95: Math.round(conditionalVaR95 * 10000) / 10000,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 10000,
    beta: Math.round(beta * 100) / 100,
    correlationMatrix,
    sectorExposure: exposures.sector,
    countryExposure: exposures.country,
    currencyExposure: exposures.currency,
    concentrationHhi: Math.round(computeConcentrationHhi(weights) * 10000) / 10000,
  };
}
