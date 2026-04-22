// ════════════════════════════════════════════════════════════════
//  Analytics by News Impact — Backtesting Engine
//
//  Segments completed trades by news impact level to evaluate
//  whether news intelligence improves trade outcomes.
//
//  Buckets: no_news, low_impact, medium_impact, high_impact
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';

/** Trade with optional news fields for analytics. SimulatedTrade.outcome maps to outcomeLabel. */
type CompletedTrade = SimulatedTrade & {
  outcomeLabel?: string;
  newsImpactScore?: number | null;
  newsConfidenceModifier?: number | null;
  pnlR?: number;
};

export interface NewsImpactAnalytics {
  bucket:        string;
  trades:        number;
  winRate:       number;
  expectancyR:   number;
  avgMFE:        number;
  avgMAE:        number;
  profitFactor:  number;
  avgConfMod:    number;   // average confidence modifier applied
  insight:       string;
}

function classifyBucket(impactScore: number | null | undefined): string {
  if (impactScore == null) return 'no_news';
  // Handle both 0-1 (normalized) and 0-100 (legacy) scales
  const score = impactScore <= 1 ? impactScore * 100 : impactScore;
  if (score < 30) return 'low_impact';
  if (score < 60) return 'medium_impact';
  return 'high_impact';
}

export function analyzeByNewsImpact(trades: CompletedTrade[]): NewsImpactAnalytics[] {
  const buckets = new Map<string, CompletedTrade[]>();

  for (const t of trades) {
    const bucket = classifyBucket((t as any).newsImpactScore);
    const list = buckets.get(bucket) ?? [];
    list.push(t);
    buckets.set(bucket, list);
  }

  const results: NewsImpactAnalytics[] = [];

  for (const [bucket, items] of buckets) {
    const n = items.length;
    if (n === 0) continue;

    const wins = items.filter((t) => t.outcomeLabel === 'win' || t.target1Hit).length;
    const winRate = round(wins / n);

    const totalR = items.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const expectancyR = round(totalR / n, 3);

    const avgMFE = round(items.reduce((s, t) => s + (t.mfePct ?? 0), 0) / n, 3);
    const avgMAE = round(items.reduce((s, t) => s + Math.abs(t.maePct ?? 0), 0) / n, 3);

    const grossWin = items.filter((t) => (t.pnlR ?? 0) > 0).reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const grossLoss = Math.abs(items.filter((t) => (t.pnlR ?? 0) < 0).reduce((s, t) => s + (t.pnlR ?? 0), 0));
    const profitFactor = grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? 99 : 0;

    const avgConfMod = round(
      items.reduce((s, t) => s + ((t as any).newsConfidenceModifier ?? 0), 0) / n,
      2,
    );

    const insight = buildInsight(bucket, winRate, expectancyR, n, avgConfMod);

    results.push({
      bucket, trades: n, winRate, expectancyR, avgMFE, avgMAE,
      profitFactor, avgConfMod, insight,
    });
  }

  return results.sort((a, b) => {
    const order = ['no_news', 'low_impact', 'medium_impact', 'high_impact'];
    return order.indexOf(a.bucket) - order.indexOf(b.bucket);
  });
}

function buildInsight(
  bucket: string,
  winRate: number,
  expectancyR: number,
  trades: number,
  avgConfMod: number,
): string {
  const winPct = (winRate * 100).toFixed(0);
  const label = bucket.replace(/_/g, ' ');

  if (bucket === 'no_news') {
    return `Trades without news context: ${winPct}% win rate, ${expectancyR}R expectancy over ${trades} trades. Baseline for comparison.`;
  }

  const modDirection = avgConfMod > 0 ? `boosted by avg +${avgConfMod}` : avgConfMod < 0 ? `penalized by avg ${avgConfMod}` : 'no modifier applied';

  if (expectancyR > 0.2 && winRate > 0.55) {
    return `${label}: ${winPct}% win rate, ${expectancyR}R expectancy over ${trades} trades (${modDirection}). News intelligence adds value.`;
  }
  if (expectancyR < -0.1) {
    return `${label}: ${winPct}% win rate, ${expectancyR}R expectancy over ${trades} trades (${modDirection}). News signals may be misleading — review calibration.`;
  }
  return `${label}: ${winPct}% win rate, ${expectancyR}R expectancy over ${trades} trades (${modDirection}).`;
}

// ════════════════════════════════════════════════════════════════
//  Comparison Analytics — technical-only vs enriched-news
// ════════════════════════════════════════════════════════════════

export interface NewsValueComparison {
  technicalOnly: NewsImpactAnalytics;
  enrichedNews: NewsImpactAnalytics;
  delta: {
    winRateDelta: number;
    expectancyRDelta: number;
    profitFactorDelta: number;
    avgMFEDelta: number;
    avgMAEDelta: number;
    falsePositiveReduction: number;   // % of avoided bad trades
  };
  verdict: string;
}

/**
 * Compare technical-only baseline vs enriched-news performance.
 * Requires two trade sets from the same backtest period.
 */
export function compareNewsValue(
  technicalOnlyTrades: CompletedTrade[],
  enrichedNewsTrades: CompletedTrade[],
): NewsValueComparison {
  const techAnalytics = analyzeByNewsImpact(technicalOnlyTrades);
  const enrichAnalytics = analyzeByNewsImpact(enrichedNewsTrades);

  const techAll = aggregateBuckets(techAnalytics);
  const enrichAll = aggregateBuckets(enrichAnalytics);

  // Count false positives (stopped out trades) avoided by news filtering
  const techStops = technicalOnlyTrades.filter(t => t.outcomeLabel === 'stopped_out' || (t.pnlR ?? 0) <= -1).length;
  const enrichStops = enrichedNewsTrades.filter(t => t.outcomeLabel === 'stopped_out' || (t.pnlR ?? 0) <= -1).length;
  const falsePositiveReduction = techStops > 0 ? round((techStops - enrichStops) / techStops, 4) : 0;

  const delta = {
    winRateDelta: round(enrichAll.winRate - techAll.winRate, 4),
    expectancyRDelta: round(enrichAll.expectancyR - techAll.expectancyR, 4),
    profitFactorDelta: round(enrichAll.profitFactor - techAll.profitFactor, 4),
    avgMFEDelta: round(enrichAll.avgMFE - techAll.avgMFE, 4),
    avgMAEDelta: round(enrichAll.avgMAE - techAll.avgMAE, 4),
    falsePositiveReduction,
  };

  let verdict: string;
  if (delta.expectancyRDelta > 0.1 && delta.winRateDelta > 0.02) {
    verdict = 'Enriched news intelligence meaningfully improves trade outcomes.';
  } else if (delta.expectancyRDelta > 0) {
    verdict = 'Enriched news provides marginal improvement — continue calibrating.';
  } else if (delta.falsePositiveReduction > 0.1) {
    verdict = 'Enriched news reduces false positives even if raw expectancy is similar.';
  } else {
    verdict = 'No measurable improvement from enriched news in this period — review scoring calibration.';
  }

  return {
    technicalOnly: techAll,
    enrichedNews: enrichAll,
    delta,
    verdict,
  };
}

function aggregateBuckets(analytics: NewsImpactAnalytics[]): NewsImpactAnalytics {
  const totalTrades = analytics.reduce((s, a) => s + a.trades, 0);
  if (totalTrades === 0) {
    return { bucket: 'all', trades: 0, winRate: 0, expectancyR: 0, avgMFE: 0, avgMAE: 0, profitFactor: 0, avgConfMod: 0, insight: 'No trades.' };
  }
  const winRate = analytics.reduce((s, a) => s + a.winRate * a.trades, 0) / totalTrades;
  const expectancyR = analytics.reduce((s, a) => s + a.expectancyR * a.trades, 0) / totalTrades;
  const avgMFE = analytics.reduce((s, a) => s + a.avgMFE * a.trades, 0) / totalTrades;
  const avgMAE = analytics.reduce((s, a) => s + a.avgMAE * a.trades, 0) / totalTrades;
  const profitFactor = analytics.reduce((s, a) => s + a.profitFactor * a.trades, 0) / totalTrades;
  const avgConfMod = analytics.reduce((s, a) => s + a.avgConfMod * a.trades, 0) / totalTrades;
  return {
    bucket: 'all',
    trades: totalTrades,
    winRate: round(winRate),
    expectancyR: round(expectancyR, 3),
    avgMFE: round(avgMFE, 3),
    avgMAE: round(avgMAE, 3),
    profitFactor: round(profitFactor),
    avgConfMod: round(avgConfMod, 2),
    insight: `Aggregate over ${totalTrades} trades.`,
  };
}

// ════════════════════════════════════════════════════════════════
//  Grouped Analytics — by news trait dimensions
// ════════════════════════════════════════════════════════════════

export type GroupDimension = 'impact_level' | 'source_class' | 'manipulation_level' | 'alignment';

/**
 * Group trade analytics by a news trait dimension.
 * Allows evaluation of which news characteristics contribute
 * most to trade quality.
 */
export function analyzeByNewsTraitGroup(
  trades: CompletedTrade[],
  dimension: GroupDimension,
): NewsImpactAnalytics[] {
  const groupFn = getGrouper(dimension);
  const buckets = new Map<string, CompletedTrade[]>();

  for (const t of trades) {
    const bucket = groupFn(t);
    const list = buckets.get(bucket) ?? [];
    list.push(t);
    buckets.set(bucket, list);
  }

  const results: NewsImpactAnalytics[] = [];
  for (const [bucket, items] of buckets) {
    const n = items.length;
    if (n === 0) continue;

    const wins = items.filter(t => t.outcomeLabel === 'win' || t.target1Hit).length;
    const winRate = round(wins / n);
    const totalR = items.reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const expectancyR = round(totalR / n, 3);
    const avgMFE = round(items.reduce((s, t) => s + (t.mfePct ?? 0), 0) / n, 3);
    const avgMAE = round(items.reduce((s, t) => s + Math.abs(t.maePct ?? 0), 0) / n, 3);
    const grossWin = items.filter(t => (t.pnlR ?? 0) > 0).reduce((s, t) => s + (t.pnlR ?? 0), 0);
    const grossLoss = Math.abs(items.filter(t => (t.pnlR ?? 0) < 0).reduce((s, t) => s + (t.pnlR ?? 0), 0));
    const profitFactor = grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? 99 : 0;
    const avgConfMod = round(items.reduce((s, t) => s + ((t as any).newsConfidenceModifier ?? 0), 0) / n, 2);

    results.push({
      bucket: `${dimension}:${bucket}`,
      trades: n,
      winRate,
      expectancyR,
      avgMFE,
      avgMAE,
      profitFactor,
      avgConfMod,
      insight: `${dimension} group "${bucket}": ${n} trades, ${(winRate * 100).toFixed(0)}% win rate, ${expectancyR}R expectancy.`,
    });
  }

  return results;
}

function getGrouper(dimension: GroupDimension): (t: CompletedTrade) => string {
  switch (dimension) {
    case 'impact_level':
      return (t) => classifyBucket((t as any).newsImpactScore);
    case 'source_class':
      return (t) => (t as any).sourceClass ?? 'unknown';
    case 'manipulation_level':
      return (t) => {
        const manip = (t as any).manipulationSuspicion ?? (t as any).newsManipulationSuspicion ?? 0;
        // Handle both 0-1 (normalized) and 0-100 (legacy) scales
        const score = manip <= 1 ? manip : manip / 100;
        if (score >= 0.6) return 'high_manipulation';
        if (score >= 0.3) return 'moderate_manipulation';
        return 'low_manipulation';
      };
    case 'alignment':
      return (t) => (t as any).newsAlignment ?? 'unknown';
  }
}

function round(val: number, decimals = 4): number {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}
