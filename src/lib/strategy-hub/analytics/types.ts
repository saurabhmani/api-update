// ════════════════════════════════════════════════════════════════
//  Strategy Hub — Performance & Analytics types (Phase 5)
// ════════════════════════════════════════════════════════════════

import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';

/** Analytics windows extend Phase-2 windows with intraday TODAY. */
export type AnalyticsWindow = PerformanceWindow | 'TODAY';

export const ANALYTICS_WINDOWS: readonly AnalyticsWindow[] = [
  'TODAY', '7D', '30D', '90D', '180D', '1Y', 'ALL',
] as const;

export interface SignalPipelineCounts {
  totalSignalsGenerated: number;
  approvedSignals: number;
  confirmedSignals: number;
  executedTrades: number;
  openTrades: number;
}

export interface ExtendedPerformanceMetrics {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  cagrPct: number | null;
  averageConfidence: number | null;
  medianConfidence: number | null;
  approvalRate: number;
  signalQualityScore: number;
}

export interface PerformanceSummary extends SignalPipelineCounts, ExtendedPerformanceMetrics {
  strategyId: string;
  strategyName: string;
  winRate: number;
  lossRate: number;
  averageReturnPct: number;
  averageHoldingPeriod: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdownPct: number;
  strategyHealthScore: number;
  healthLabel: string;
  performanceStatus: string;
  performanceSource: string;
  dataStatus: string;
  evaluatedSignals: number;
}

export interface RegimeAnalyticsRow {
  regime: string;
  trades: number;
  winRate: number;
  averageReturnPct: number;
  averageConfidence: number | null;
  drawdownPct: number;
  profitFactor: number;
  expectancy: number;
}

export interface RegimeAnalytics {
  rows: RegimeAnalyticsRow[];
  bestRegime: RegimeAnalyticsRow | null;
  worstRegime: RegimeAnalyticsRow | null;
  recommendedRegimes: string[];
  dataStatus: 'AVAILABLE' | 'INSUFFICIENT_DATA';
  message?: string;
}

export interface DimensionBucket {
  key: string;
  label: string;
  signalCount: number;
  evaluatedSignals: number;
  winRate: number;
  averageReturnPct: number;
  averageConfidence: number | null;
  approvalRate: number;
  profitFactor: number;
}

export interface SectorAnalytics {
  sectors: DimensionBucket[];
  industries: DimensionBucket[];
  marketCaps: DimensionBucket[];
  exchanges: DimensionBucket[];
  dataStatus: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';
  message?: string;
}

export interface ConfidenceDistribution {
  histogram: Array<{
    bucket: string;
    lowerBound: number;
    upperBound: number;
    count: number;
    winRate: number;
    averageReturnPct: number;
  }>;
  average: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
  highConfidenceStrategies?: string[];
  lowConfidenceStrategies?: string[];
}

export interface TrendPoint {
  period: string;
  winRate: number;
  drawdownPct: number;
  returnPct: number;
  signalQuality: number;
  approvalRate: number;
  averageConfidence: number | null;
  trades: number;
}

export interface TrendAnalytics {
  granularity: 'daily' | 'weekly' | 'monthly';
  points: TrendPoint[];
}

export interface RankingEntry {
  rank: number;
  strategyId: string;
  strategyName: string;
  category: string;
  direction: string;
  overallScore: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  expectancy: number;
  strategyHealthScore: number;
  riskAdjustedReturn: number;
  consistencyScore: number;
  signalQualityScore: number;
  averageConfidence: number | null;
  stabilityScore: number;
  evaluatedSignals: number;
  trend: 'up' | 'down' | 'flat';
  medal: 'gold' | 'silver' | 'bronze' | null;
}

export interface OptimizationRecommendation {
  id: string;
  category: 'parameter' | 'regime' | 'risk' | 'exposure' | 'confidence' | 'general';
  action: string;
  reason: string;
  expectedImpact: string;
  confidenceLevel: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface LearningInsights {
  status: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT_DATA';
  recommendations: OptimizationRecommendation[];
  whatWorked: string[];
  whatFailed: string[];
  learningTags: string[];
  calibrationWarnings: string[];
}

export interface ComparativeStrategySnapshot {
  strategyId: string;
  strategyName: string;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  expectancy: number;
  sharpeRatio: number | null;
  averageConfidence: number | null;
  overallScore: number;
  bestRegime: string | null;
  topSector: string | null;
}

export interface ComparativeAnalysis {
  strategies: ComparativeStrategySnapshot[];
  betterPerformer: string | null;
  strongerRiskProfile: string | null;
  moreConsistent: string | null;
  highlights: string[];
}

export interface StrategyAnalyticsDashboard {
  generatedAt: string;
  window: AnalyticsWindow;
  strategyId: string;
  summary: PerformanceSummary | null;
  regime: RegimeAnalytics | null;
  sector: SectorAnalytics | null;
  confidence: ConfidenceDistribution | null;
  trends: TrendAnalytics | null;
  learning: LearningInsights | null;
  rankings: RankingEntry[];
  charts: {
    equityCurve: Array<{ date: string; equity: number; pnl: number }>;
    drawdown: Array<{ date: string; drawdown: number }>;
    monthlyReturns: Array<{ month: string; returnPct: number; trades: number }>;
  };
  sourceStatus: {
    directOutcomeRows: number;
    observedSnapshotRows: number;
    backtestTradeRows: number;
    pipelineSignals: number;
  };
  cached: boolean;
  cacheAgeMs: number | null;
}
