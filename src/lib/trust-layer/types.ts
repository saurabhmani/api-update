// ════════════════════════════════════════════════════════════════
//  Trust Layer — shared wire types
// ════════════════════════════════════════════════════════════════

export type TrustRegimeCategory = 'bullish' | 'bearish' | 'sideways' | 'high_volatility';

export type TrustLabel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';

export interface TrustMarketSummary {
  benchmarkSymbol: string;
  benchmarkChangePct: number | null;
  marketOpen: boolean;
  sessionLabel: string;
  lastUpdated: string;
}

export interface TrustDashboardPayload {
  marketSummary: TrustMarketSummary;
  activeSignals: number;
  runningStrategies: number;
  todayPnl: number;
  todayPnlPct: number;
  winRate: number;
  riskExposure: number;
  riskSeverity: 'ok' | 'info' | 'warning' | 'critical';
  /** True when the user has at least one portfolio row. When false, the
   *  UI should render "N/A" for P&L / risk instead of misleading zeros. */
  hasPortfolio: boolean;
  marketRegime: TrustRegimeSnapshot;
  trustScore: {
    score: number;
    label: TrustLabel;
    reasons: string[];
  };
}

export interface TrustRegimeSnapshot {
  label: string;
  category: TrustRegimeCategory;
  allowBullishSignals: boolean;
  strength: number;
  confidence: number;
  volatilityRegime: string;
  trendSlope: number;
  details: {
    rsi: number;
    atrPct: number;
    closeVsEma20: number;
    closeVsEma50: number;
  };
  source: 'index' | 'cohort_proxy' | 'insufficient_data';
  capturedAt: string;
}

export interface TrustSignalBoardRow {
  id: number;
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategy: string | null;
  strategyDisplay: string | null;
  entry: number;
  stopLoss: number;
  targets: number[];
  /** Full trade plan */
  tradePlan: {
    entry: number;
    stopLoss: number;
    target1: number;
    target2: number | null;
    riskReward: number;
    profitPercent: number;
    lossPercent: number;
    expectedEdgePercent: number;
    validUntil: string | null;
  };
  confidence: number;
  baseConfidence: number;
  regimeModifier: number;
  regimeAdjustmentReason: string;
  riskReward: number;
  reasons: string[];
  warnings: string[];
  /** Where the reasons were sourced from (database columns, explanation_json,
   *  strategy registry). Surfaced in UI as small badges to explain provenance. */
  reasonSources: Array<'database' | 'explanation' | 'registry'>;
  warningSources: Array<'database' | 'explanation' | 'engine'>;
  /** Higher-severity warnings (e.g. institutional flow, dark-pool prints). */
  institutionalWarnings: string[];
  status: string;
  lifecycle: 'active' | 'closed';
  confirmedAt: string | null;
  livePrice: number | null;
}

export interface TrustStrategyPerformanceRow {
  strategyId: string;
  displayName: string;
  winRate: number;
  totalTrades: number;
  averageProfit: number;
  /** Magnitude of average losing trade (%), always ≥ 0. */
  averageLoss: number;
  bestTrade: number;
  worstTrade: number;
  dataStatus: 'AVAILABLE' | 'INSUFFICIENT';
  /** Mirrors the Phase-2 performance gate — LIMITED rows have 5–19
   *  evaluated signals; SUFFICIENT rows have ≥ 20. */
  performanceStatus?: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT_DATA';
  performanceSource?: string;
  healthLabel?: string;
}

export interface TrustWatchlistItem {
  instrumentKey: string;
  tradingsymbol: string;
  exchange: string;
  name: string | null;
  category: TrustWatchlistCategory;
  ltp: number | null;
  changePct: number | null;
  direction: string;
  confidence: number | null;
  opportunityScore: number;
  rejectionReasons: string[];
  warnings: string[];
}

export type TrustWatchlistCategory =
  | 'actionable'
  | 'emerging'
  | 'blocked'
  | 'low_confidence'
  | 'regime_mismatch'
  | 'no_data';

export interface SignalReasonResult {
  signalId: number;
  symbol: string;
  reasons: string[];
  confirmationReasons: string[];
  sources: Array<'database' | 'explanation' | 'registry'>;
}

export interface SignalWarningResult {
  signalId: number;
  symbol: string;
  warnings: string[];
  institutionalWarnings: string[];
  sources: Array<'database' | 'explanation' | 'engine'>;
}
