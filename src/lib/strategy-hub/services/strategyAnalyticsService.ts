// ════════════════════════════════════════════════════════════════
//  Strategy Hub — Performance & Analytics service (Phase 5)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  VALID_WINDOWS,
  loadBacktestOutcomes,
  loadDirectSignalOutcomes,
  loadObservedOutcomes,
  loadStrategyPerformanceSnapshots,
  buildPerformanceReport,
  dedupeOutcomesBySignal,
  windowCutoffIso,
  type PerformanceOutcomeRow,
  type PerformanceWindow,
  type StrategyPerformance,
} from '@/lib/strategies/strategyPerformance';
import { getStrategyMeta, STRATEGY_REGISTRY } from '@strategy-engine';
import {
  analyticsCacheKey,
  getAnalyticsCache,
  setAnalyticsCache,
} from '../analytics/analyticsCache';
import {
  buildComparativeAnalysis,
  buildConfidenceDistribution,
  buildEquityCharts,
  buildExtendedRanking,
  buildLearningInsights,
  buildRegimeAnalytics,
  buildSectorAnalytics,
  buildSignalPipelineCounts,
  buildTrendAnalytics,
  computeExtendedMetrics,
} from '../analytics/analyticsBuilders';
import { loadInstrumentMeta } from '../analytics/instrumentEnrichment';
import type {
  AnalyticsWindow,
  ComparativeAnalysis,
  PerformanceSummary,
  RankingEntry,
  SignalPipelineCounts,
  StrategyAnalyticsDashboard,
} from '../analytics/types';

export type AnalyticsSection =
  | 'summary'
  | 'regime'
  | 'sector'
  | 'confidence'
  | 'trends'
  | 'learning'
  | 'rankings'
  | 'charts';

const ALL_SECTIONS: AnalyticsSection[] = [
  'summary', 'regime', 'sector', 'confidence', 'trends', 'learning', 'rankings', 'charts',
];

function parseAnalyticsWindow(raw: string | null): AnalyticsWindow {
  const v = String(raw ?? '90D').toUpperCase();
  if (v === 'TODAY') return 'TODAY';
  if (VALID_WINDOWS.has(v as PerformanceWindow)) return v as PerformanceWindow;
  return '90D';
}

function todayCutoffIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function filterTodayRows(rows: PerformanceOutcomeRow[]): PerformanceOutcomeRow[] {
  const cutoff = todayCutoffIso();
  return rows.filter((r) => {
    const ts = r.evaluatedAt ?? '';
    return ts >= cutoff;
  });
}

export async function loadOutcomesForWindow(window: AnalyticsWindow): Promise<{
  outcomes: PerformanceOutcomeRow[];
  direct: number;
  observed: number;
  backtests: number;
}> {
  const perfWindow: PerformanceWindow = window === 'TODAY' ? '7D' : window;
  const [direct, observed, backtests] = await Promise.all([
    loadDirectSignalOutcomes(perfWindow).catch(() => []),
    loadObservedOutcomes(perfWindow).catch(() => []),
    loadBacktestOutcomes(perfWindow).catch(() => []),
  ]);
  let outcomes = dedupeOutcomesBySignal([...direct, ...observed, ...backtests]);
  if (window === 'TODAY') outcomes = filterTodayRows(outcomes);
  return {
    outcomes,
    direct: direct.length,
    observed: observed.length,
    backtests: backtests.length,
  };
}

export async function loadSignalPipelineCounts(
  strategyId: string,
  window: AnalyticsWindow,
): Promise<SignalPipelineCounts> {
  const cutoff = window === 'TODAY' ? todayCutoffIso() : windowCutoffIso(window as PerformanceWindow);
  const where = cutoff ? 'AND s.generated_at >= ?' : '';
  const params = cutoff ? [strategyId, cutoff] : [strategyId];

  try {
    const { rows } = await db.query<{
      total: number;
      approved: number;
      confirmed: number;
    }>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN s.classification IN ('APPROVED','APPROVED_SIGNAL')
                   OR s.status = 'APPROVED_SIGNAL' THEN 1 ELSE 0 END) AS approved,
         (SELECT COUNT(DISTINCT c.signal_id)
            FROM q365_confirmed_signal_snapshots c
            JOIN q365_signals s2 ON s2.id = c.signal_id
           WHERE s2.signal_type = ?
             ${cutoff ? 'AND c.created_at >= ?' : ''}
         ) AS confirmed
       FROM q365_signals s
      WHERE s.signal_type = ?
        ${where}`,
      cutoff
        ? [strategyId, cutoff, strategyId, cutoff]
        : [strategyId, strategyId],
    );
    const row = rows?.[0];
    return {
      totalSignalsGenerated: Number(row?.total ?? 0),
      approvedSignals: Number(row?.approved ?? 0),
      confirmedSignals: Number(row?.confirmed ?? 0),
      executedTrades: 0,
      openTrades: 0,
    };
  } catch {
    return {
      totalSignalsGenerated: 0,
      approvedSignals: 0,
      confirmedSignals: 0,
      executedTrades: 0,
      openTrades: 0,
    };
  }
}

function buildSummary(
  strategyId: string,
  perf: StrategyPerformance | null,
  rows: PerformanceOutcomeRow[],
  pipeline: SignalPipelineCounts,
  window: AnalyticsWindow,
): PerformanceSummary | null {
  if (!perf && rows.length === 0) return null;
  const extended = computeExtendedMetrics(rows, window, perf);
  const pipelineCounts = buildSignalPipelineCounts(
    { ...pipeline, executedTrades: perf?.evaluatedSignals ?? pipeline.executedTrades, openTrades: perf?.openSignals ?? 0 },
    perf,
  );
  const meta = getStrategyMeta(strategyId);
  return {
    strategyId,
    strategyName: perf?.strategyName ?? meta.strategyName,
    ...pipelineCounts,
    winRate: perf?.winRate ?? 0,
    lossRate: perf?.lossRate ?? 0,
    averageReturnPct: perf?.averageReturnPct ?? 0,
    averageHoldingPeriod: perf?.averageHoldingPeriod ?? 0,
    profitFactor: perf?.profitFactor ?? 0,
    expectancy: perf?.expectancy ?? 0,
    maxDrawdownPct: perf?.maxDrawdownPct ?? 0,
    strategyHealthScore: perf?.strategyHealthScore ?? 0,
    healthLabel: perf?.healthLabel ?? 'INSUFFICIENT_DATA',
    performanceStatus: perf?.performanceStatus ?? 'INSUFFICIENT_DATA',
    performanceSource: perf?.performanceSource ?? 'insufficient_data',
    dataStatus: perf?.performanceStatus ?? 'INSUFFICIENT_DATA',
    evaluatedSignals: perf?.evaluatedSignals ?? 0,
    ...extended,
  };
}

export interface LoadAnalyticsOptions {
  strategyId: string;
  window?: AnalyticsWindow;
  sections?: AnalyticsSection[];
  skipCache?: boolean;
  filters?: {
    regime?: string | null;
    sector?: string | null;
    category?: string | null;
    riskProfile?: string | null;
  };
}

export async function loadStrategyAnalytics(
  opts: LoadAnalyticsOptions,
): Promise<StrategyAnalyticsDashboard> {
  const window = opts.window ?? '90D';
  const sections = new Set(opts.sections?.length ? opts.sections : ALL_SECTIONS);
  const cacheKey = analyticsCacheKey({
    ns: 'strategy-analytics',
    strategyId: opts.strategyId,
    window,
    sections: Array.from(sections).sort().join(','),
    regime: opts.filters?.regime,
    sector: opts.filters?.sector,
  });

  if (!opts.skipCache) {
    const cached = getAnalyticsCache<StrategyAnalyticsDashboard>(cacheKey);
    if (cached) {
      return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs };
    }
  }

  const started = Date.now();
  const [{ outcomes, direct, observed, backtests }, snapshots, pipeline] = await Promise.all([
    loadOutcomesForWindow(window),
    loadStrategyPerformanceSnapshots(window === 'TODAY' ? '7D' : window as PerformanceWindow).catch(() => new Map()),
    sections.has('summary') ? loadSignalPipelineCounts(opts.strategyId, window) : Promise.resolve({
      totalSignalsGenerated: 0, approvedSignals: 0, confirmedSignals: 0, executedTrades: 0, openTrades: 0,
    }),
  ]);

  let strategyRows = outcomes.filter((o) => o.strategyId === opts.strategyId);
  if (opts.filters?.regime) {
    strategyRows = strategyRows.filter(
      (r) => String(r.regime ?? '').toLowerCase() === opts.filters!.regime!.toLowerCase(),
    );
  }
  if (opts.filters?.sector) {
    strategyRows = strategyRows.filter(
      (r) => String(r.sector ?? '').toLowerCase() === opts.filters!.sector!.toLowerCase(),
    );
  }

  const { report } = buildPerformanceReport(outcomes, window === 'TODAY' ? '7D' : window as PerformanceWindow, snapshots);
  const perf = report.strategies.find((s) => s.strategyId === opts.strategyId) ?? null;

  if (opts.filters?.category && perf && perf.category !== opts.filters.category) {
    strategyRows = [];
  }

  const outcomesByStrategy = new Map<string, PerformanceOutcomeRow[]>();
  for (const row of outcomes) {
    const list = outcomesByStrategy.get(row.strategyId) ?? [];
    list.push(row);
    outcomesByStrategy.set(row.strategyId, list);
  }

  const symbols = strategyRows.map((r) => r.symbol);
  const instrumentMeta = sections.has('sector')
    ? await loadInstrumentMeta(symbols)
    : new Map();

  const rankings = sections.has('rankings')
    ? buildExtendedRanking(report.strategies, outcomesByStrategy)
    : [];

  const dashboard: StrategyAnalyticsDashboard = {
    generatedAt: new Date().toISOString(),
    window,
    strategyId: opts.strategyId,
    summary: sections.has('summary')
      ? buildSummary(opts.strategyId, perf, strategyRows, pipeline, window)
      : null,
    regime: sections.has('regime') ? buildRegimeAnalytics(strategyRows) : null,
    sector: sections.has('sector') ? buildSectorAnalytics(strategyRows, instrumentMeta) : null,
    confidence: sections.has('confidence') ? buildConfidenceDistribution(strategyRows) : null,
    trends: sections.has('trends') ? buildTrendAnalytics(strategyRows, window) : null,
    learning: sections.has('learning')
      ? buildLearningInsights(strategyRows, opts.strategyId, window === 'TODAY' ? '7D' : window as PerformanceWindow)
      : null,
    rankings,
    charts: sections.has('charts') ? buildEquityCharts(strategyRows) : { equityCurve: [], drawdown: [], monthlyReturns: [] },
    sourceStatus: {
      directOutcomeRows: direct,
      observedSnapshotRows: observed,
      backtestTradeRows: backtests,
      pipelineSignals: pipeline.totalSignalsGenerated,
    },
    cached: false,
    cacheAgeMs: Date.now() - started,
  };

  setAnalyticsCache(cacheKey, dashboard);
  return dashboard;
}

export interface RankingsOptions {
  window?: AnalyticsWindow;
  regime?: string | null;
  sector?: string | null;
  category?: string | null;
  riskProfile?: string | null;
  skipCache?: boolean;
}

export async function loadStrategyRankings(opts: RankingsOptions = {}): Promise<{
  generatedAt: string;
  window: AnalyticsWindow;
  rankings: RankingEntry[];
  cached: boolean;
}> {
  const window = opts.window ?? '90D';
  const cacheKey = analyticsCacheKey({
    ns: 'rankings',
    window,
    regime: opts.regime,
    sector: opts.sector,
    category: opts.category,
  });

  if (!opts.skipCache) {
    const cached = getAnalyticsCache<{ generatedAt: string; window: AnalyticsWindow; rankings: RankingEntry[] }>(cacheKey);
    if (cached) return { ...cached.value, cached: true };
  }

  const { outcomes } = await loadOutcomesForWindow(window);
  let filtered = outcomes;
  if (opts.regime) {
    filtered = filtered.filter((r) => String(r.regime ?? '').toLowerCase() === opts.regime!.toLowerCase());
  }
  if (opts.sector) {
    filtered = filtered.filter((r) => String(r.sector ?? '').toLowerCase() === opts.sector!.toLowerCase());
  }

  const { report } = buildPerformanceReport(filtered, window === 'TODAY' ? '7D' : window as PerformanceWindow);
  let strategies = report.strategies;
  if (opts.category) strategies = strategies.filter((s) => s.category === opts.category);
  if (opts.riskProfile) {
    strategies = strategies.filter((s) => {
      const entry = (STRATEGY_REGISTRY as Record<string, { riskProfile?: string }>)[s.strategyId];
      return entry?.riskProfile === opts.riskProfile;
    });
  }

  const outcomesByStrategy = new Map<string, PerformanceOutcomeRow[]>();
  for (const row of filtered) {
    const list = outcomesByStrategy.get(row.strategyId) ?? [];
    list.push(row);
    outcomesByStrategy.set(row.strategyId, list);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    window,
    rankings: buildExtendedRanking(strategies, outcomesByStrategy),
  };
  setAnalyticsCache(cacheKey, payload);
  return { ...payload, cached: false };
}

export async function loadComparativeAnalytics(
  strategyIds: string[],
  window: AnalyticsWindow = '90D',
): Promise<ComparativeAnalysis> {
  const unique = Array.from(new Set(strategyIds.filter(Boolean)));
  if (unique.length === 0) {
    return { strategies: [], betterPerformer: null, strongerRiskProfile: null, moreConsistent: null, highlights: [] };
  }

  const cacheKey = analyticsCacheKey({ ns: 'compare', window, ids: unique.sort().join(',') });
  const cached = getAnalyticsCache<ComparativeAnalysis>(cacheKey);
  if (cached) return cached.value;

  const { outcomes } = await loadOutcomesForWindow(window);
  const filtered = outcomes.filter((o) => unique.includes(o.strategyId));
  const { report } = buildPerformanceReport(filtered, window === 'TODAY' ? '7D' : window as PerformanceWindow);
  const strategies = report.strategies.filter((s) => unique.includes(s.strategyId));

  const outcomesByStrategy = new Map<string, PerformanceOutcomeRow[]>();
  const regimeByStrategy = new Map();
  const sectorByStrategy = new Map();
  const symbols = filtered.map((r) => r.symbol);
  const instrumentMeta = await loadInstrumentMeta(symbols);

  for (const id of unique) {
    const rows = filtered.filter((r) => r.strategyId === id);
    outcomesByStrategy.set(id, rows);
    regimeByStrategy.set(id, buildRegimeAnalytics(rows));
    sectorByStrategy.set(id, buildSectorAnalytics(rows, instrumentMeta));
  }

  const result = buildComparativeAnalysis(strategies, outcomesByStrategy, regimeByStrategy, sectorByStrategy);
  setAnalyticsCache(cacheKey, result);
  return result;
}

export { parseAnalyticsWindow, ALL_SECTIONS };
