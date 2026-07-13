// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — diversification analysis (Phase 8)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import type { InstrumentMeta } from '../analytics/instrumentEnrichment';
import type { DiversificationAnalysis, DiversificationBucket, StrategyPortfolioContext } from './types';
import { diversificationScoreFromHhi, herfindahlIndex, round2 } from './portfolioMath';

function bucketize(
  entries: Array<{ key: string; label: string; weight: number; trades: number; strategies: Set<string> }>,
): DiversificationBucket[] {
  return entries
    .map((e) => ({
      key: e.key,
      label: e.label,
      weightPct: round2(e.weight),
      tradeCount: e.trades,
      strategyCount: e.strategies.size,
    }))
    .sort((a, b) => b.weightPct - a.weightPct);
}

function accumulate(
  map: Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>,
  key: string,
  label: string,
  weight: number,
  strategyId: string,
) {
  const cur = map.get(key) ?? { label, weight: 0, trades: 0, strategies: new Set<string>() };
  cur.weight += weight;
  cur.trades += 1;
  cur.strategies.add(strategyId);
  map.set(key, cur);
}

export function buildDiversificationAnalysis(
  contexts: StrategyPortfolioContext[],
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>,
  instrumentMeta: Map<string, InstrumentMeta>,
  totalCapital: number,
): DiversificationAnalysis {
  const active = contexts.filter((c) => c.allocatedAmount > 0);
  const weights = active.map((c) => c.allocatedPct || (totalCapital > 0 ? (c.allocatedAmount / totalCapital) * 100 : 0));
  const hhi = herfindahlIndex(weights);
  const divScore = diversificationScoreFromHhi(hhi, active.length);

  const strategyType = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();
  const sector = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();
  const industry = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();
  const marketCap = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();
  const exchange = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();
  const regime = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();
  const riskProfile = new Map<string, { label: string; weight: number; trades: number; strategies: Set<string> }>();

  for (const ctx of active) {
    const w = ctx.allocatedPct || (totalCapital > 0 ? (ctx.allocatedAmount / totalCapital) * 100 : 0);
    accumulate(strategyType, ctx.category, ctx.category, w, ctx.strategyId);
    accumulate(riskProfile, ctx.riskProfile, ctx.riskProfile, w, ctx.strategyId);

    const rows = outcomesByStrategy.get(ctx.strategyId) ?? [];
    for (const row of rows) {
      const meta = instrumentMeta.get(row.symbol);
      const rowWeight = w / Math.max(rows.length, 1);
      accumulate(sector, meta?.sector ?? row.sector ?? 'Unknown', meta?.sector ?? row.sector ?? 'Unknown', rowWeight, ctx.strategyId);
      accumulate(industry, meta?.industry ?? 'Unknown', meta?.industry ?? 'Unknown', rowWeight, ctx.strategyId);
      accumulate(marketCap, meta?.marketCapBucket ?? 'Unknown', meta?.marketCapBucket ?? 'Unknown', rowWeight, ctx.strategyId);
      const exch = meta?.exchange ?? (row.symbol.endsWith('.BO') ? 'BSE' : 'NSE');
      accumulate(exchange, exch, exch, rowWeight, ctx.strategyId);
      accumulate(regime, String(row.regime ?? 'Unknown'), String(row.regime ?? 'Unknown'), rowWeight, ctx.strategyId);
    }
  }

  const recommendations: string[] = [];
  const topSector = bucketize(Array.from(sector.entries()).map(([k, v]) => ({ key: k, ...v })))[0];
  if (topSector && topSector.weightPct > 45) {
    recommendations.push(`Reduce ${topSector.label} sector exposure (currently ${topSector.weightPct}%) by allocating to strategies in other sectors.`);
  }
  if (active.length < 4) {
    recommendations.push('Deploy at least 4 strategies with capital to improve diversification.');
  }
  if (divScore < 40) {
    recommendations.push('Portfolio diversification score is low — consider rebalancing toward uncorrelated strategies.');
  }
  const topStrategy = active.sort((a, b) => b.allocatedPct - a.allocatedPct)[0];
  if (topStrategy && topStrategy.allocatedPct > 35) {
    recommendations.push(`Rebalance away from ${topStrategy.strategyName} (${topStrategy.allocatedPct}% allocation).`);
  }
  if (!recommendations.length) {
    recommendations.push('Current diversification profile is acceptable for the allocated strategy set.');
  }

  return {
    diversificationScore: divScore,
    herfindahlIndex: round2(hhi),
    strategyType: bucketize(Array.from(strategyType.entries()).map(([k, v]) => ({ key: k, ...v }))),
    sector: bucketize(Array.from(sector.entries()).map(([k, v]) => ({ key: k, ...v }))),
    industry: bucketize(Array.from(industry.entries()).map(([k, v]) => ({ key: k, ...v }))),
    marketCap: bucketize(Array.from(marketCap.entries()).map(([k, v]) => ({ key: k, ...v }))),
    exchange: bucketize(Array.from(exchange.entries()).map(([k, v]) => ({ key: k, ...v }))),
    regime: bucketize(Array.from(regime.entries()).map(([k, v]) => ({ key: k, ...v }))),
    riskProfile: bucketize(Array.from(riskProfile.entries()).map(([k, v]) => ({ key: k, ...v }))),
    recommendations,
  };
}
