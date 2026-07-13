// ════════════════════════════════════════════════════════════════
//  Strategy analytics builders (Phase 5)
// ════════════════════════════════════════════════════════════════

import {
  buildConfidenceBuckets,
  buildRegimeBuckets,
  buildSectorBuckets,
  type PerformanceOutcomeRow,
  type StrategyPerformance,
} from '@/lib/strategies/strategyPerformance';
import { buildLearningReport } from '@/lib/learning/signalReviewEngine';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';
import type { InstrumentMeta } from './instrumentEnrichment';
import {
  computeAverageConfidence,
  computeCagrFromReturns,
  computeConfidencePercentiles,
  computeConsistencyScore,
  computeRiskAdjustedFromReturns,
  windowDaysForAnalytics,
} from './riskMetrics';
import type {
  AnalyticsWindow,
  ComparativeAnalysis,
  ComparativeStrategySnapshot,
  ConfidenceDistribution,
  DimensionBucket,
  LearningInsights,
  OptimizationRecommendation,
  RankingEntry,
  RegimeAnalytics,
  RegimeAnalyticsRow,
  SectorAnalytics,
  SignalPipelineCounts,
  TrendAnalytics,
  TrendPoint,
} from './types';

function round(value: number, precision = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function pct(ratio: number): number {
  return round(ratio * 100, 1);
}

function evaluatedRows(rows: PerformanceOutcomeRow[]): PerformanceOutcomeRow[] {
  return rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
}

function profitFactorFor(rows: PerformanceOutcomeRow[]): number {
  const evaluated = evaluatedRows(rows);
  const wins = evaluated.filter((r) => r.outcome === 'WIN');
  const losses = evaluated.filter((r) => r.outcome === 'LOSS');
  const grossProfit = wins
    .map((r) => r.returnPct ?? 0)
    .filter(Number.isFinite)
    .reduce((s, v) => s + Math.max(0, v), 0);
  const grossLoss = Math.abs(
    losses
      .map((r) => r.returnPct ?? 0)
      .filter(Number.isFinite)
      .reduce((s, v) => s + Math.min(0, v), 0),
  );
  return round(grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0, 2);
}

function drawdownFor(rows: PerformanceOutcomeRow[]): number {
  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  for (const row of evaluatedRows(rows)) {
    equity = round(equity * (1 + (row.returnPct ?? 0) / 100), 4);
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
    maxDd = Math.min(maxDd, dd);
  }
  return round(maxDd, 2);
}

function bucketFromRows(
  key: string,
  label: string,
  rows: PerformanceOutcomeRow[],
): DimensionBucket {
  const evaluated = evaluatedRows(rows);
  const wins = evaluated.filter((r) => r.outcome === 'WIN');
  const returns = evaluated
    .map((r) => r.returnPct)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const approved = rows.filter((r) => r.approvalStatus === 'APPROVED').length;
  return {
    key,
    label,
    signalCount: rows.length,
    evaluatedSignals: evaluated.length,
    winRate: pct(evaluated.length > 0 ? wins.length / evaluated.length : 0),
    averageReturnPct: round(
      returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0,
      2,
    ),
    averageConfidence: computeAverageConfidence(rows),
    approvalRate: pct(rows.length > 0 ? approved / rows.length : 0),
    profitFactor: profitFactorFor(rows),
  };
}

export function buildSignalPipelineCounts(
  pipeline: SignalPipelineCounts | null,
  perf: StrategyPerformance | null,
): SignalPipelineCounts {
  if (pipeline) return pipeline;
  return {
    totalSignalsGenerated: perf?.totalSignals ?? 0,
    approvedSignals: perf?.approvedSignals ?? 0,
    confirmedSignals: perf?.approvedSignals ?? 0,
    executedTrades: perf?.evaluatedSignals ?? 0,
    openTrades: perf?.openSignals ?? 0,
  };
}

export function buildRegimeAnalytics(rows: PerformanceOutcomeRow[]): RegimeAnalytics {
  const buckets = buildRegimeBuckets(rows);
  if (buckets.length === 0) {
    return {
      rows: [],
      bestRegime: null,
      worstRegime: null,
      recommendedRegimes: [],
      dataStatus: 'INSUFFICIENT_DATA',
      message: 'Market regime not recorded on historical signals — regime-wise analysis unavailable.',
    };
  }

  const analyticsRows: RegimeAnalyticsRow[] = buckets.map((b) => {
    const regimeRows = rows.filter((r) => r.regime === b.regime);
    return {
      regime: b.regime,
      trades: b.evaluatedSignals,
      winRate: b.winRate,
      averageReturnPct: b.averageReturnPct,
      averageConfidence: computeAverageConfidence(regimeRows),
      drawdownPct: drawdownFor(regimeRows),
      profitFactor: profitFactorFor(regimeRows),
      expectancy: b.expectancy,
    };
  });

  const ranked = [...analyticsRows].filter((r) => r.trades >= 3);
  const best = ranked.length
    ? ranked.sort((a, b) => b.expectancy - a.expectancy || b.winRate - a.winRate)[0]
    : null;
  const worst = ranked.length
    ? ranked.sort((a, b) => a.expectancy - b.expectancy || a.winRate - b.winRate)[0]
    : null;

  const recommendedRegimes = analyticsRows
    .filter((r) => r.trades >= 5 && r.winRate >= 50 && r.expectancy > 0)
    .sort((a, b) => b.expectancy - a.expectancy)
    .slice(0, 3)
    .map((r) => r.regime);

  return {
    rows: analyticsRows,
    bestRegime: best,
    worstRegime: worst,
    recommendedRegimes,
    dataStatus: 'AVAILABLE',
  };
}

export function buildSectorAnalytics(
  rows: PerformanceOutcomeRow[],
  instrumentMeta: Map<string, InstrumentMeta>,
): SectorAnalytics {
  const sectorBuckets = buildSectorBuckets(rows);
  const sectors: DimensionBucket[] = sectorBuckets.map((b) =>
    bucketFromRows(b.sector, b.sector, rows.filter((r) => (r.sector ?? 'Unknown') === b.sector)),
  );

  const industryMap = new Map<string, PerformanceOutcomeRow[]>();
  const capMap = new Map<string, PerformanceOutcomeRow[]>();
  const exchangeMap = new Map<string, PerformanceOutcomeRow[]>();

  for (const row of rows) {
    const meta = instrumentMeta.get(row.symbol.toUpperCase());
    const industry = meta?.industry ?? 'Unknown';
    const cap = meta?.marketCapBucket ?? 'Unknown';
    const exchange = meta?.exchange ?? (row.symbol.endsWith('.BO') ? 'BSE' : 'NSE');

    if (!industryMap.has(industry)) industryMap.set(industry, []);
    industryMap.get(industry)!.push(row);
    if (!capMap.has(cap)) capMap.set(cap, []);
    capMap.get(cap)!.push(row);
    if (!exchangeMap.has(exchange)) exchangeMap.set(exchange, []);
    exchangeMap.get(exchange)!.push(row);
  }

  const industries = Array.from(industryMap.entries())
    .map(([key, group]) => bucketFromRows(key, key, group))
    .sort((a, b) => b.signalCount - a.signalCount);

  const marketCaps = Array.from(capMap.entries())
    .map(([key, group]) => bucketFromRows(key, key, group))
    .sort((a, b) => b.signalCount - a.signalCount);

  const exchanges = Array.from(exchangeMap.entries())
    .map(([key, group]) => bucketFromRows(key, key, group))
    .sort((a, b) => b.signalCount - a.signalCount);

  const hasSector = sectors.some((s) => s.key !== 'Unknown' && s.key !== 'Other');
  return {
    sectors,
    industries,
    marketCaps,
    exchanges,
    dataStatus: hasSector ? 'AVAILABLE' : sectors.length > 0 ? 'PARTIAL' : 'UNAVAILABLE',
    message: hasSector ? undefined : 'Sector mapping is limited — using symbol fallbacks where instrument data is absent.',
  };
}

export function buildConfidenceDistribution(rows: PerformanceOutcomeRow[]): ConfidenceDistribution {
  const buckets = buildConfidenceBuckets(rows);
  const percentiles = computeConfidencePercentiles(rows);
  return {
    histogram: buckets.map((b) => ({
      bucket: b.bucket,
      lowerBound: b.lowerBound,
      upperBound: b.upperBound,
      count: b.signals,
      winRate: b.winRate,
      averageReturnPct: b.averageReturnPct,
    })),
    ...percentiles,
  };
}

export function buildTrendAnalytics(
  rows: PerformanceOutcomeRow[],
  window: AnalyticsWindow,
): TrendAnalytics {
  const evaluated = evaluatedRows(rows).filter((r) => r.evaluatedAt);
  const granularity: TrendAnalytics['granularity'] =
    window === 'TODAY' || window === '7D' ? 'daily'
    : window === '30D' || window === '90D' ? 'weekly'
    : 'monthly';

  const grouped = new Map<string, PerformanceOutcomeRow[]>();
  for (const row of evaluated) {
    const date = row.evaluatedAt!.slice(0, 10);
    let key = date;
    if (granularity === 'weekly') {
      const d = new Date(date);
      const week = Math.ceil((d.getDate() + 6 - d.getDay()) / 7);
      key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    } else if (granularity === 'monthly') {
      key = date.slice(0, 7);
    }
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const points: TrendPoint[] = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, group]) => {
      const wins = evaluatedRows(group).filter((r) => r.outcome === 'WIN');
      const ev = evaluatedRows(group);
      const approved = group.filter((r) => r.approvalStatus === 'APPROVED').length;
      const returns = ev.map((r) => r.returnPct ?? 0).filter(Number.isFinite);
      const signalQuality = ev.length
        ? round((wins.length / ev.length) * 50 + profitFactorFor(group) * 15, 1)
        : 0;
      return {
        period,
        winRate: pct(ev.length > 0 ? wins.length / ev.length : 0),
        drawdownPct: drawdownFor(group),
        returnPct: round(returns.reduce((s, v) => s + v, 0), 2),
        signalQuality,
        approvalRate: pct(group.length > 0 ? approved / group.length : 0),
        averageConfidence: computeAverageConfidence(group),
        trades: ev.length,
      };
    });

  return { granularity, points };
}

export function buildExtendedRanking(
  strategies: StrategyPerformance[],
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>,
  previousRanks?: Map<string, number>,
): RankingEntry[] {
  const entries = strategies.map((s) => {
    const rows = outcomesByStrategy.get(s.strategyId) ?? [];
    const returns = evaluatedRows(rows)
      .map((r) => r.returnPct)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const { sharpeRatio } = computeRiskAdjustedFromReturns(returns);
    const consistencyScore = computeConsistencyScore(returns);
    const avgConf = computeAverageConfidence(rows);
    const approved = rows.filter((r) => r.approvalStatus === 'APPROVED').length;
    const signalQualityScore = round(
      s.approvalAccuracy * 0.4 + s.winRate * 0.3 + Math.min(s.profitFactor, 3) * 10,
      1,
    );
    const riskAdjustedReturn = sharpeRatio != null ? round(sharpeRatio * 10 + s.expectancy * 5, 1) : s.expectancy * 5;
    const stabilityScore = round((consistencyScore + s.strategyHealthScore) / 2, 1);
    const overallScore = round(
      s.strategyHealthScore * 0.25
      + s.winRate * 0.15
      + Math.min(s.profitFactor, 5) * 8
      + Math.max(0, 25 + s.maxDrawdownPct) * 0.15
      + s.expectancy * 10
      + consistencyScore * 0.1
      + signalQualityScore * 0.1
      + (avgConf ?? 50) * 0.05,
      1,
    );
    return {
      strategyId: s.strategyId,
      strategyName: s.strategyName,
      category: s.category,
      direction: s.direction,
      overallScore,
      winRate: s.winRate,
      profitFactor: s.profitFactor,
      maxDrawdownPct: s.maxDrawdownPct,
      expectancy: s.expectancy,
      strategyHealthScore: s.strategyHealthScore,
      riskAdjustedReturn,
      consistencyScore,
      signalQualityScore,
      averageConfidence: avgConf,
      stabilityScore,
      evaluatedSignals: s.evaluatedSignals,
      approvalRate: pct(rows.length > 0 ? approved / rows.length : 0),
      _sort: overallScore,
    };
  });

  entries.sort((a, b) => b._sort - a._sort);
  return entries.map((e, i) => {
    const rank = i + 1;
    const prev = previousRanks?.get(e.strategyId);
    const trend: RankingEntry['trend'] =
      prev == null ? 'flat' : rank < prev ? 'up' : rank > prev ? 'down' : 'flat';
    const medal: RankingEntry['medal'] =
      rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null;
    const { _sort, ...rest } = e as typeof e & { _sort: number };
    return { rank, ...rest, trend, medal };
  });
}

export function buildLearningInsights(
  rows: PerformanceOutcomeRow[],
  strategyId: string,
  window: PerformanceWindow,
): LearningInsights {
  const report = buildLearningReport(rows, window);
  const review = report.reviews.find((r) => r.strategyId === strategyId);

  const recommendations: OptimizationRecommendation[] = [];

  if (review) {
    for (const tag of review.learningTags) {
      if (tag === 'regime_mismatch') {
        recommendations.push({
          id: `${strategyId}-regime`,
          category: 'regime',
          action: 'Disable or reduce weight in underperforming regimes',
          reason: 'Historical signals show regime mismatch losses.',
          expectedImpact: 'Reduce false positives in hostile market conditions.',
          confidenceLevel: review.reviewStatus === 'SUFFICIENT' ? 'high' : 'medium',
          evidence: review.whatFailed.filter((w) => w.toLowerCase().includes('regime')),
        });
      }
      if (tag === 'stop_too_tight') {
        recommendations.push({
          id: `${strategyId}-stop`,
          category: 'risk',
          action: 'Widen stop-loss buffer or reduce position size',
          reason: 'Frequent stop-outs before favorable excursion.',
          expectedImpact: 'Lower whipsaw rate; may increase average loss size.',
          confidenceLevel: 'medium',
          evidence: review.whatFailed,
        });
      }
    }

    if (review.recommendation === 'Reduce Approval Weight') {
      recommendations.push({
        id: `${strategyId}-weight`,
        category: 'exposure',
        action: 'Reduce approval weighting in Phase 3',
        reason: review.explanation,
        expectedImpact: 'Fewer low-quality approvals; improved portfolio hit rate.',
        confidenceLevel: 'high',
        evidence: [...review.whatFailed, ...report.calibrationWarnings],
      });
    }

    for (const note of review.calibrationNotes) {
      if (note.toLowerCase().includes('confidence') || note.toLowerCase().includes('rsi')) {
        recommendations.push({
          id: `${strategyId}-cal-${recommendations.length}`,
          category: 'confidence',
          action: note.includes('RSI') ? 'Increase RSI threshold' : 'Increase confidence weighting',
          reason: note,
          expectedImpact: 'Better signal selectivity and calibration alignment.',
          confidenceLevel: 'medium',
          evidence: [note],
        });
      }
    }
  }

  for (const rec of report.recommendations.filter((r) => r.strategyId === strategyId)) {
    recommendations.push({
      id: `${strategyId}-${rec.action}`,
      category: 'general',
      action: rec.action,
      reason: rec.explanation,
      expectedImpact: rec.action.includes('Promote')
        ? 'Higher allocation to proven edge.'
        : 'Risk reduction through selective deployment.',
      confidenceLevel: report.learningStatus === 'SUFFICIENT' ? 'high' : 'medium',
      evidence: review?.whatWorked ?? [],
    });
  }

  return {
    status: review?.reviewStatus ?? report.learningStatus,
    recommendations,
    whatWorked: review?.whatWorked ?? [],
    whatFailed: review?.whatFailed ?? [],
    learningTags: review?.learningTags ?? [],
    calibrationWarnings: report.calibrationWarnings,
  };
}

export function buildComparativeAnalysis(
  strategies: StrategyPerformance[],
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>,
  regimeByStrategy: Map<string, RegimeAnalytics>,
  sectorByStrategy: Map<string, SectorAnalytics>,
): ComparativeAnalysis {
  const snapshots: ComparativeStrategySnapshot[] = strategies.map((s) => {
    const rows = outcomesByStrategy.get(s.strategyId) ?? [];
    const returns = evaluatedRows(rows)
      .map((r) => r.returnPct)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const { sharpeRatio } = computeRiskAdjustedFromReturns(returns);
    const regime = regimeByStrategy.get(s.strategyId);
    const sector = sectorByStrategy.get(s.strategyId);
    const ranking = buildExtendedRanking([s], outcomesByStrategy);
    return {
      strategyId: s.strategyId,
      strategyName: s.strategyName,
      winRate: s.winRate,
      profitFactor: s.profitFactor,
      maxDrawdownPct: s.maxDrawdownPct,
      expectancy: s.expectancy,
      sharpeRatio,
      averageConfidence: computeAverageConfidence(rows),
      overallScore: ranking[0]?.overallScore ?? s.strategyHealthScore,
      bestRegime: regime?.bestRegime?.regime ?? null,
      topSector: sector?.sectors[0]?.label ?? null,
    };
  });

  if (snapshots.length === 0) {
    return { strategies: [], betterPerformer: null, strongerRiskProfile: null, moreConsistent: null, highlights: [] };
  }

  const betterPerformer = [...snapshots].sort((a, b) => b.overallScore - a.overallScore)[0]?.strategyId ?? null;
  const strongerRiskProfile = [...snapshots].sort(
    (a, b) => b.maxDrawdownPct - a.maxDrawdownPct || (b.sharpeRatio ?? 0) - (a.sharpeRatio ?? 0),
  )[0]?.strategyId ?? null;
  const moreConsistent = [...snapshots].sort((a, b) => b.winRate - a.winRate || b.profitFactor - a.profitFactor)[0]?.strategyId ?? null;

  const highlights: string[] = [];
  if (betterPerformer) {
    const winner = snapshots.find((s) => s.strategyId === betterPerformer);
    if (winner) highlights.push(`${winner.strategyName} leads on overall performance score (${winner.overallScore}).`);
  }
  if (strongerRiskProfile) {
    const risk = snapshots.find((s) => s.strategyId === strongerRiskProfile);
    if (risk) highlights.push(`${risk.strategyName} shows the strongest risk profile (drawdown ${risk.maxDrawdownPct}%).`);
  }

  return { strategies: snapshots, betterPerformer, strongerRiskProfile, moreConsistent, highlights };
}

export function computeExtendedMetrics(
  rows: PerformanceOutcomeRow[],
  window: AnalyticsWindow,
  perf: StrategyPerformance | null,
): {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  cagrPct: number | null;
  averageConfidence: number | null;
  medianConfidence: number | null;
  approvalRate: number;
  signalQualityScore: number;
} {
  const returns = evaluatedRows(rows)
    .map((r) => r.returnPct)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const { sharpeRatio, sortinoRatio } = computeRiskAdjustedFromReturns(returns);
  const percentiles = computeConfidencePercentiles(rows);
  const approved = rows.filter((r) => r.approvalStatus === 'APPROVED').length;
  const signalQualityScore = perf
    ? round(perf.approvalAccuracy * 0.5 + perf.winRate * 0.3 + Math.min(perf.profitFactor, 3) * 8, 1)
    : 0;
  return {
    sharpeRatio,
    sortinoRatio,
    cagrPct: computeCagrFromReturns(returns, windowDaysForAnalytics(window)),
    averageConfidence: percentiles.average,
    medianConfidence: percentiles.median,
    approvalRate: pct(rows.length > 0 ? approved / rows.length : 0),
    signalQualityScore,
  };
}

export function buildEquityCharts(rows: PerformanceOutcomeRow[]) {
  const evaluated = evaluatedRows(rows)
    .filter((r) => typeof r.returnPct === 'number' && Number.isFinite(r.returnPct))
    .sort((a, b) => String(a.evaluatedAt ?? '').localeCompare(String(b.evaluatedAt ?? '')));

  let equity = 100;
  let peak = 100;
  const equityCurve: Array<{ date: string; equity: number; pnl: number }> = [];
  const drawdown: Array<{ date: string; drawdown: number }> = [];
  const monthly = new Map<string, { returnPct: number; trades: number }>();

  for (const [index, row] of evaluated.entries()) {
    const pnl = row.returnPct ?? 0;
    equity = round(equity * (1 + pnl / 100), 2);
    peak = Math.max(peak, equity);
    const date = row.evaluatedAt?.slice(0, 10) ?? `Trade ${index + 1}`;
    equityCurve.push({ date, equity, pnl: round(pnl, 2) });
    const dd = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
    drawdown.push({ date, drawdown: round(dd, 2) });
    const month = (row.evaluatedAt ?? '').slice(0, 7);
    if (month) {
      const cur = monthly.get(month) ?? { returnPct: 0, trades: 0 };
      cur.returnPct = round(cur.returnPct + pnl, 2);
      cur.trades += 1;
      monthly.set(month, cur);
    }
  }

  return {
    equityCurve,
    drawdown,
    monthlyReturns: Array.from(monthly.entries()).map(([month, v]) => ({ month, ...v })),
  };
}
