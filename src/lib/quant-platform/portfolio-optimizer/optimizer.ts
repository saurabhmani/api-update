// Portfolio Optimizer — allocation, risk, diversification metrics

import { computeExposure } from '@/services/riskCoreService';
import { getPortfolioOverview } from '@/services/portfolioLedgerService';
import { pearsonCorrelation } from '@/lib/signal-engine/correlation/correlationEngine';
import { db } from '@/lib/db';
import type { OptimizationResult, PortfolioAllocation } from '../types';
import { saveOptimization } from '../repository/quantRepository';

interface HoldingRow {
  symbol: string;
  quantity: number;
  avg_price: number;
  sector?: string;
}

function herfindahlIndex(weights: number[]): number {
  return weights.reduce((s, w) => s + (w / 100) ** 2, 0);
}

async function loadCandles(symbol: string, days = 90): Promise<number[]> {
  try {
    const { rows } = await db.query(
      `SELECT close FROM market_data_daily WHERE symbol = ? ORDER BY ts DESC LIMIT ?`,
      [symbol, days + 1],
    );
    const closes = (rows as any[]).map((r) => Number(r.close)).reverse();
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    return returns;
  } catch {
    return [];
  }
}

function inverseVolWeight(volatilities: Record<string, number>): Record<string, number> {
  const inv: Record<string, number> = {};
  let sum = 0;
  for (const [sym, vol] of Object.entries(volatilities)) {
    const w = vol > 0 ? 1 / vol : 0;
    inv[sym] = w;
    sum += w;
  }
  if (sum === 0) return {};
  const norm: Record<string, number> = {};
  for (const [sym, w] of Object.entries(inv)) {
    norm[sym] = w / sum;
  }
  return norm;
}

export async function optimizePortfolio(
  userId: number,
  portfolioId: number,
): Promise<OptimizationResult> {
  const [overview, exposure] = await Promise.all([
    getPortfolioOverview(portfolioId),
    computeExposure(portfolioId),
  ]);

  const holdings: HoldingRow[] = (overview.holdings ?? []).map((p) => ({
    symbol: p.ticker,
    quantity: Number(p.quantity ?? 0),
    avg_price: Number(p.marketPrice ?? p.avgCost ?? 0),
    sector: p.sector ?? undefined,
  }));

  const totalValue = overview.totalAum || holdings.reduce((s, h) => s + h.quantity * h.avg_price, 0) || 1;
  const volatilities: Record<string, number> = {};
  const returnsMap: Record<string, number[]> = {};

  for (const h of holdings) {
    const rets = await loadCandles(h.symbol);
    returnsMap[h.symbol] = rets;
    if (rets.length > 5) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
      volatilities[h.symbol] = Math.sqrt(variance) || 0.01;
    } else {
      volatilities[h.symbol] = 0.02;
    }
  }

  const targetWeights = inverseVolWeight(volatilities);

  const symbols = holdings.map((h) => h.symbol);
  let corrSum = 0;
  let corrCount = 0;
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const corr = pearsonCorrelation(returnsMap[symbols[i]] ?? [], returnsMap[symbols[j]] ?? []);
      if (!Number.isNaN(corr)) {
        corrSum += Math.abs(corr);
        corrCount++;
        if (corr > 0.7) {
          targetWeights[symbols[j]] = (targetWeights[symbols[j]] ?? 0) * 0.85;
        }
      }
    }
  }

  const twSum = Object.values(targetWeights).reduce((a, b) => a + b, 0) || 1;
  for (const sym of Object.keys(targetWeights)) {
    targetWeights[sym] /= twSum;
  }

  const allocations: PortfolioAllocation[] = holdings.map((h) => {
    const currentWeight = (h.quantity * h.avg_price) / totalValue;
    const targetWeight = targetWeights[h.symbol] ?? currentWeight;
    return {
      symbol: h.symbol,
      sector: h.sector,
      currentWeight: Math.round(currentWeight * 1000) / 10,
      targetWeight: Math.round(targetWeight * 1000) / 10,
      delta: Math.round((targetWeight - currentWeight) * 1000) / 10,
    };
  });

  const sectorExposure: Record<string, number> = {};
  for (const a of allocations) {
    const sec = a.sector ?? 'Unknown';
    sectorExposure[sec] = (sectorExposure[sec] ?? 0) + a.targetWeight;
  }

  const targetWeightPcts = allocations.map((a) => a.targetWeight);
  const hhi = herfindahlIndex(targetWeightPcts);
  const effectivePositions = hhi > 0 ? Math.round((1 / hhi) * 10) / 10 : 0;
  const maxPositionWeight = Math.max(...targetWeightPcts, 0);
  const maxSectorWeight = Math.max(...Object.values(sectorExposure), 0);
  const diversificationScore = Math.max(0, Math.min(100,
    Math.round((1 - hhi) * 60 + (effectivePositions / Math.max(1, holdings.length)) * 40),
  ));

  const avgVol = Object.values(volatilities).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(volatilities).length);
  const avgCorr = corrCount ? corrSum / corrCount : 0;

  const result: OptimizationResult = {
    allocations,
    metrics: {
      portfolioVolatility: Math.round(avgVol * 10000) / 100,
      avgCorrelation: corrCount ? Math.round(avgCorr * 100) / 100 : 0,
      sectorExposure,
      riskScore: Math.min(100, Math.round(avgVol * 500 + avgCorr * 30)),
      herfindahlIndex: Math.round(hhi * 1000) / 1000,
      effectivePositions,
      diversificationScore,
      maxPositionWeight: Math.round(maxPositionWeight * 10) / 10,
      maxSectorWeight: Math.round(maxSectorWeight * 10) / 10,
    },
    constraints: [
      'Max single position: 25%',
      'Sector cap: 40%',
      'Inverse-volatility weighting with correlation penalty',
    ],
    explainability: [
      'Targets minimize portfolio volatility via inverse-vol weighting.',
      `Average pairwise correlation: ${corrCount ? avgCorr.toFixed(2) : 'N/A'}.`,
      `Diversification score: ${diversificationScore}/100 (HHI: ${hhi.toFixed(3)}, effective positions: ${effectivePositions}).`,
      `Current gross exposure: ₹${Math.round(exposure?.grossExposure ?? 0).toLocaleString()}.`,
    ],
  };

  await saveOptimization(userId, portfolioId, result);
  return result;
}
