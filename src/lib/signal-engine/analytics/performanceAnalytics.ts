import type { OutcomeAnalyticsRecord } from './outcomeAnalytics';

export const PERFORMANCE_ANALYTICS_VERSION = '3.0.0';

export type PerformanceDimension =
  | 'strategy'
  | 'sector'
  | 'symbol'
  | 'marketRegime'
  | 'timeframe'
  | 'week'
  | 'month'
  | 'quarter';

export interface PerformanceMetric {
  dimension: PerformanceDimension;
  key: string;
  sampleCount: number;
  winRate: number;
  averageReturnPct: number;
  averageHoldingPeriodBars: number;
  averageRewardRisk: number;
  maximumDrawdownR: number;
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function periodKey(value: string, dimension: 'week' | 'month' | 'quarter'): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const year = date.getUTCFullYear();
  if (dimension === 'month') return `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  if (dimension === 'quarter') return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;

  const first = new Date(Date.UTC(year, 0, 1));
  const dayOffset = Math.floor((date.getTime() - first.getTime()) / 86_400_000);
  const week = Math.floor((dayOffset + first.getUTCDay()) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function keyFor(record: OutcomeAnalyticsRecord, dimension: PerformanceDimension): string {
  switch (dimension) {
    case 'strategy': return record.strategy;
    case 'sector': return record.sector ?? 'unknown';
    case 'symbol': return record.symbol;
    case 'marketRegime': return record.marketRegime;
    case 'timeframe': return record.timeframe;
    case 'week':
    case 'month':
    case 'quarter':
      return periodKey(record.generatedAt, dimension);
  }
}

function maxDrawdownR(records: readonly OutcomeAnalyticsRecord[]): number {
  const ordered = [...records].sort((a, b) =>
    a.generatedAt.localeCompare(b.generatedAt) || a.signalId - b.signalId,
  );
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const record of ordered) {
    equity += record.outcome.realizedRewardRisk ?? record.outcome.pnlR;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return round(drawdown);
}

export function aggregatePerformanceMetrics(
  records: readonly OutcomeAnalyticsRecord[],
  dimension: PerformanceDimension,
): PerformanceMetric[] {
  const groups = new Map<string, OutcomeAnalyticsRecord[]>();
  for (const record of records) {
    const key = keyFor(record, dimension);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, rows]) => {
    const n = rows.length;
    const wins = rows.filter((row) => row.outcome.target1Hit && row.outcome.exitReason !== 'stop').length;
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / n;
    return {
      dimension,
      key,
      sampleCount: n,
      winRate: round(wins / n),
      averageReturnPct: round(mean(rows.map((row) => row.outcome.realizedReturnPct ?? 0))),
      averageHoldingPeriodBars: round(mean(rows.map((row) => row.outcome.holdingDurationBars ?? 0)), 2),
      averageRewardRisk: round(mean(rows.map((row) => row.outcome.realizedRewardRisk ?? row.outcome.pnlR))),
      maximumDrawdownR: maxDrawdownR(rows),
    };
  }).sort((a, b) => b.averageRewardRisk - a.averageRewardRisk || b.sampleCount - a.sampleCount);
}

export function buildAllPerformanceDimensions(
  records: readonly OutcomeAnalyticsRecord[],
): Record<PerformanceDimension, PerformanceMetric[]> {
  const dimensions: PerformanceDimension[] = [
    'strategy', 'sector', 'symbol', 'marketRegime', 'timeframe', 'week', 'month', 'quarter',
  ];
  return Object.fromEntries(
    dimensions.map((dimension) => [dimension, aggregatePerformanceMetrics(records, dimension)]),
  ) as Record<PerformanceDimension, PerformanceMetric[]>;
}
