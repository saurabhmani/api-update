import {
  summarizeOutcomeIntelligence,
  type OutcomeAnalyticsRecord,
  type OutcomeIntelligenceSummary,
} from './outcomeAnalytics';
import {
  buildConfidenceCalibrationReport,
  type ConfidenceCalibrationReport,
} from './confidenceAnalytics';
import {
  buildAllPerformanceDimensions,
  aggregatePerformanceMetrics,
  type PerformanceDimension,
  type PerformanceMetric,
} from './performanceAnalytics';
import {
  buildFeatureOutcomeAssociations,
  classifyHistoricalEnvironment,
  type FeatureOutcomeAssociation,
  type HistoricalEnvironment,
} from './regimeAndExplainabilityAnalytics';

export const PERFORMANCE_REPORT_VERSION = '3.0.0';

export interface ProductAPerformanceReport {
  reportVersion: string;
  generatedAt: string;
  overall: OutcomeIntelligenceSummary;
  strategyLeaderboard: PerformanceMetric[];
  confidenceCalibration: ConfidenceCalibrationReport;
  featureImportanceSummary: FeatureOutcomeAssociation[];
  marketRegimeSummary: Record<HistoricalEnvironment, PerformanceMetric[]>;
  recent30DayTrends: Record<PerformanceDimension, PerformanceMetric[]>;
  performanceDimensions: ReturnType<typeof buildAllPerformanceDimensions>;
  historicalComparison: {
    baselineSampleCount: number;
    winRateDelta: number;
    realizedRewardRiskDelta: number;
  } | null;
}

function stableGeneratedAt(records: readonly OutcomeAnalyticsRecord[]): string {
  const latest = records.reduce((max, record) => {
    const candidate = Date.parse(record.outcome.evaluatedAt || record.generatedAt);
    return Number.isFinite(candidate) ? Math.max(max, candidate) : max;
  }, 0);
  return latest > 0 ? new Date(latest).toISOString() : '1970-01-01T00:00:00.000Z';
}

function filterRecent30Days(
  records: readonly OutcomeAnalyticsRecord[],
  asOf: string,
): OutcomeAnalyticsRecord[] {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return [...records];
  const cutoff = asOfMs - 30 * 86_400_000;
  return records.filter((record) => {
    const time = Date.parse(record.generatedAt);
    return Number.isFinite(time) && time >= cutoff && time <= asOfMs;
  });
}

export function buildProductAPerformanceReport(
  records: readonly OutcomeAnalyticsRecord[],
  options: {
    generatedAt?: string;
    baselineRecords?: readonly OutcomeAnalyticsRecord[];
  } = {},
): ProductAPerformanceReport {
  const generatedAt = options.generatedAt ?? stableGeneratedAt(records);
  const overall = summarizeOutcomeIntelligence(records);
  const performanceDimensions = buildAllPerformanceDimensions(records);
  const recent = filterRecent30Days(records, generatedAt);
  const recent30DayTrends = buildAllPerformanceDimensions(recent);

  const byEnvironment = new Map<HistoricalEnvironment, OutcomeAnalyticsRecord[]>();
  for (const record of records) {
    const environment = classifyHistoricalEnvironment({
      marketRegime: `${record.marketRegime} ${record.volatilityState ?? ''}`.trim(),
      manualTags: record.manualTags,
    });
    const group = byEnvironment.get(environment) ?? [];
    group.push({ ...record, marketRegime: environment });
    byEnvironment.set(environment, group);
  }

  const environments: HistoricalEnvironment[] = [
    'trending', 'range_bound', 'high_volatility', 'low_volatility', 'gap_driven', 'news_driven',
  ];
  const marketRegimeSummary = Object.fromEntries(
    environments.map((environment) => [
      environment,
      aggregatePerformanceMetrics(byEnvironment.get(environment) ?? [], 'strategy'),
    ]),
  ) as Record<HistoricalEnvironment, PerformanceMetric[]>;

  const baseline = options.baselineRecords
    ? summarizeOutcomeIntelligence(options.baselineRecords)
    : null;

  return {
    reportVersion: PERFORMANCE_REPORT_VERSION,
    generatedAt,
    overall,
    strategyLeaderboard: performanceDimensions.strategy,
    confidenceCalibration: buildConfidenceCalibrationReport(records),
    featureImportanceSummary: buildFeatureOutcomeAssociations(records),
    marketRegimeSummary,
    recent30DayTrends,
    performanceDimensions,
    historicalComparison: baseline
      ? {
        baselineSampleCount: baseline.sampleCount,
        winRateDelta: Number((overall.target1HitRate - baseline.target1HitRate).toFixed(6)),
        realizedRewardRiskDelta: Number(
          (overall.avgRealizedRewardRisk - baseline.avgRealizedRewardRisk).toFixed(6),
        ),
      }
      : null,
  };
}

export function reportToJson(report: ProductAPerformanceReport): string {
  return JSON.stringify(report, null, 2);
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export core dashboard metrics as a stable CSV row set. */
export function reportToCsv(report: ProductAPerformanceReport): string {
  const header = ['section', 'dimension', 'key', 'sample_count', 'win_rate', 'avg_return_pct', 'avg_holding_bars', 'avg_rr', 'max_drawdown_r'];
  const rows: unknown[][] = [];

  for (const [dimension, metrics] of Object.entries(report.performanceDimensions)) {
    for (const metric of metrics) {
      rows.push([
        'performance', dimension, metric.key, metric.sampleCount, metric.winRate,
        metric.averageReturnPct, metric.averageHoldingPeriodBars,
        metric.averageRewardRisk, metric.maximumDrawdownR,
      ]);
    }
  }
  for (const bucket of report.confidenceCalibration.reliabilityCurve) {
    rows.push([
      'confidence_calibration',
      'confidence_bucket',
      `${bucket.lowerBound}-${bucket.upperBound}`,
      bucket.sampleCount,
      bucket.observedWinRate,
      '',
      '',
      bucket.meanPredictedConfidence,
      bucket.calibrationError,
    ]);
  }

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
