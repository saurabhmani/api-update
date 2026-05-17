// ════════════════════════════════════════════════════════════════
//  Quantorus365 Backtesting Engine — Complete Type System
//
//  Enterprise-grade types for historical replay, trade simulation,
//  calibration, and performance analytics.
// ════════════════════════════════════════════════════════════════

import type {
  Candle, StrategyName, MarketRegimeLabel, ConfidenceBand,
  SignalFeatures, ConfidenceBreakdown, RiskBreakdown,
} from '../../signal-engine/types/signalEngine.types';

// Re-export for convenience
export type { Candle, StrategyName, MarketRegimeLabel, ConfidenceBand };

// ════════════════════════════════════════════════════════════════
//  1. BACKTEST RUN CONFIGURATION
// ════════════════════════════════════════════════════════════════

export interface BacktestRunConfig {
  runId?: string;
  name: string;
  description?: string;
  universe: string[];
  benchmarkSymbol: string;
  startDate: string;              // YYYY-MM-DD
  endDate: string;
  warmupBars: number;             // bars before first signal (indicator init)
  evaluationHorizon: number;      // max bars to hold a trade

  // Capital & sizing
  initialCapital: number;
  riskPerTradePct: number;
  maxGrossExposurePct: number;
  maxSectorExposurePct: number;
  maxOpenPositions: number;

  // Filters
  minConfidence: number;
  minRewardRisk: number;
  maxStopWidthPct: number;
  strategies: StrategyName[] | null;  // null = all
  signalExpiryBars: number;

  // Execution assumptions (persisted for reproducibility)
  slippageBps: number;
  commissionPerTrade: number;
  fillModel: 'conservative' | 'midpoint' | 'aggressive';

  // Production hardening (Section 1, 4)
  strictDataMode?: boolean;       // reject any symbol with bad data vs repair
  maxSymbolTimeoutMs?: number;    // per-symbol signal-gen timeout
  maxConcurrency?: number;        // Section 1 — bounded parallel preload
  persistChunkSize?: number;      // Section 1 — rows per streamed INSERT batch
  debug?: boolean;                // Section 4 — enable debug-level structured logs

  // Phase 3 — manipulation engine integration
  /** Skip signals whose manipulation snapshot is at or above this threshold (0–100). */
  manipulationFilterScore?: number;
  /** Tag every backtest signal with the manipulation score at signal date. Default: true. */
  tagManipulationScore?: boolean;
  /** Free-form scenario label so the dashboard can compare runs (e.g. "with_filter", "baseline"). */
  manipulationScenario?: string;

  // Phase 5 — News intelligence integration
  /** Skip signals whose news event risk score is at or above this threshold (0–100). */
  newsFilterScore?: number;
  /** Apply news confidence modifier to signal scores during backtest. Default: false. */
  applyNewsModifier?: boolean;
  /** Free-form scenario label for news-aware comparison runs (e.g. "news_aware", "baseline"). */
  newsScenario?: string;

  // Metadata
  createdBy?: string;
  tags?: string[];
  userId?: number;                // owner — for SaaS multi-tenant scoping
}

// ════════════════════════════════════════════════════════════════
//  2. BACKTEST RUN RECORD (persisted result)
// ════════════════════════════════════════════════════════════════

export type BacktestStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed' | 'cancelled';

export interface BacktestRunRecord {
  runId: string;
  config: BacktestRunConfig;
  status: BacktestStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
  summary: BacktestSummary | null;
  strategyBreakdown: StrategyBreakdownResult[];
  regimeBreakdown: RegimeBreakdownResult[];
  signalCount: number;
  tradeCount: number;
}

// ════════════════════════════════════════════════════════════════
//  3. HISTORICAL BAR (candle + metadata for replay)
// ════════════════════════════════════════════════════════════════

export interface HistoricalBar {
  symbol: string;
  date: string;
  barIndex: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Derived: is this the last bar available for this symbol? */
  isLastBar: boolean;
}

// ════════════════════════════════════════════════════════════════
//  4. REPLAY CONTEXT (state at any point during replay)
// ════════════════════════════════════════════════════════════════

export interface ReplayContext {
  /** Current simulation date */
  currentDate: string;
  /** Current bar index in the replay sequence */
  barIndex: number;
  /** Total bars in replay */
  totalBars: number;
  /** Current portfolio equity */
  equity: number;
  /** Available cash */
  cash: number;
  /** Peak equity seen so far */
  peakEquity: number;
  /** Current drawdown % */
  currentDrawdownPct: number;
  /** Currently open positions */
  openPositions: OpenPosition[];
  /** Pending (unentered) signals */
  pendingSignals: PendingSignal[];
  /** Detected market regime on this date */
  currentRegime: MarketRegimeLabel | null;
  /** Signals generated on this date */
  todaySignalCount: number;
  /** Trades closed on this date */
  todayTradesClosedCount: number;
  /** Cumulative stats */
  totalSignalsGenerated: number;
  totalTradesTaken: number;
}

// ════════════════════════════════════════════════════════════════
//  5. SIMULATED SIGNAL (generated during replay)
// ════════════════════════════════════════════════════════════════

export interface SimulatedSignal {
  signalId: string;
  symbol: string;
  date: string;
  barIndex: number;
  direction: TradeDirection;
  strategy: StrategyName;
  regime: MarketRegimeLabel;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  riskScore: number;
  sector: string;

  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  riskPerUnit: number;
  rewardRiskApprox: number;

  reasons: string[];
  warnings: string[];

  // Tracking
  status: 'pending' | 'triggered' | 'expired' | 'filtered';
  barsWaited: number;
  expiryDate: string | null;

  // Features snapshot (for audit / calibration)
  featuresSnapshot?: SignalFeatures;
  confidenceBreakdown?: ConfidenceBreakdown;

  // Phase 3 — manipulation tagging
  manipulationScore?: number | null;
  manipulationBand?: string | null;
  excludedByManipulationFilter?: boolean;

  // Phase 5 — news intelligence tagging (all scores 0-1 normalized)
  newsImpactScore?: number | null;
  newsConfidenceModifier?: number | null;
  newsRiskPenalty?: number | null;
  newsEventRiskScore?: number | null;
  newsSentiment?: 'bullish' | 'bearish' | 'neutral' | null;
  newsWarnings?: string[];
  excludedByNewsFilter?: boolean;
  // Enriched news context (all 0-1 normalized)
  newsManipulationSuspicion?: number | null;
  newsNoveltyScore?: number | null;
  newsDirectnessScore?: number | null;
  newsSentimentScore?: number | null;
  newsSymbolImpactScore?: number | null;
  newsSourceClass?: 'official' | 'media' | 'social' | 'mixed' | 'unknown' | null;
}

// ════════════════════════════════════════════════════════════════
//  6. SIMULATED TRADE
// ════════════════════════════════════════════════════════════════

export type TradeDirection = 'long' | 'short';
export type TradeOutcome = 'win' | 'loss' | 'breakeven' | 'expired' | 'open';
export type ExitReason = 'target1' | 'target2' | 'target3' | 'stop_loss' | 'signal_expiry' | 'time_expiry' | 'manual';

export interface SimulatedTrade {
  tradeId: string;
  signalId: string;
  symbol: string;
  sector: string;
  direction: TradeDirection;
  strategy: StrategyName;
  regime: MarketRegimeLabel;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;

  signalDate: string;
  entryDate: string | null;
  exitDate: string | null;
  barsToEntry: number;
  barsInTrade: number;

  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;

  positionSize: number;
  positionValue: number;
  riskAmount: number;

  slippageCost: number;
  commissionCost: number;

  grossPnl: number;
  netPnl: number;
  returnPct: number;
  returnR: number;
  outcome: TradeOutcome;
  exitReason: ExitReason | null;

  mfePct: number;
  maePct: number;
  mfeR: number;
  maeR: number;

  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  stopHit: boolean;
  target1HitBar: number | null;
  target2HitBar: number | null;
  target3HitBar: number | null;
  stopHitBar: number | null;

  barByBarPnl: number[];
}

// ════════════════════════════════════════════════════════════════
//  7. SIGNAL OUTCOME (post-signal evaluation)
// ════════════════════════════════════════════════════════════════

export type OutcomeLabel = 'good_followthrough' | 'partial_success' | 'stopped_out' | 'stale_no_trigger' | 'expired_no_resolution' | 'ambiguous';

export interface SignalOutcome {
  signalId: string;
  tradeId: string | null;
  entryTriggered: boolean;
  barsToEntry: number | null;
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  stopHit: boolean;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  /** Profit/loss in R-multiples (risk units). */
  pnlR: number;
  returnAtBar5Pct: number | null;
  returnAtBar10Pct: number | null;
  outcomeLabel: OutcomeLabel;
  evaluatedAt: string;
}

// ════════════════════════════════════════════════════════════════
//  8. BACKTEST METRICS
// ════════════════════════════════════════════════════════════════

export interface BacktestMetric {
  metricKey: string;
  metricValue: number;
  metricUnit: string;
  category: 'return' | 'risk' | 'trade_quality' | 'excursion' | 'target' | 'efficiency';
  description: string;
}

// ════════════════════════════════════════════════════════════════
//  9. CALIBRATION BUCKET RESULT
// ════════════════════════════════════════════════════════════════

export type CalibrationState = 'well_calibrated' | 'slightly_overconfident' | 'overconfident' | 'underconfident' | 'insufficient_data';

export interface CalibrationBucketResult {
  bucket: string;                // e.g. '85_100', '70_84'
  strategy: StrategyName | 'all';
  regime: MarketRegimeLabel | 'all';
  sampleSize: number;
  expectedHitRate: number;
  actualHitRate: number;
  avgMfePct: number;
  avgMaePct: number;
  calibrationState: CalibrationState;
  confidenceModifierSuggestion: number;
}

// ════════════════════════════════════════════════════════════════
//  10. BACKTEST SUMMARY
// ════════════════════════════════════════════════════════════════

export interface BacktestSummary {
  totalSignalsGenerated: number;
  totalTradesTaken: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectancyPct: number;
  expectancyR: number;

  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  maxDrawdownDuration: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;

  avgMfePct: number;
  avgMaePct: number;
  avgBarsInTrade: number;
  target1HitRate: number;
  target2HitRate: number;
  target3HitRate: number;

  initialCapital: number;
  finalEquity: number;
  peakEquity: number;
  tradingDays: number;
}

// ════════════════════════════════════════════════════════════════
//  11. BREAKDOWNS
// ════════════════════════════════════════════════════════════════

export interface StrategyBreakdownResult {
  strategy: StrategyName;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  avgReturnR: number;
  profitFactor: number;
  avgMfePct: number;
  avgMaePct: number;
  target1HitRate: number;
  target2HitRate: number;
  bestTrade: { symbol: string; returnPct: number } | null;
  worstTrade: { symbol: string; returnPct: number } | null;
}

export interface RegimeBreakdownResult {
  regime: MarketRegimeLabel;
  totalTrades: number;
  winRate: number;
  avgReturnPct: number;
  profitFactor: number;
}

// ════════════════════════════════════════════════════════════════
//  12. EQUITY CURVE
// ════════════════════════════════════════════════════════════════

export interface EquityPoint {
  date: string;
  equity: number;
  cash: number;
  openPositionValue: number;
  drawdownPct: number;
  openPositions: number;
  dayPnl: number;
}

// ════════════════════════════════════════════════════════════════
//  13. OPEN POSITION (internal simulation state)
// ════════════════════════════════════════════════════════════════

export interface OpenPosition {
  tradeId: string;
  symbol: string;
  direction: TradeDirection;
  strategy: StrategyName;
  regime: MarketRegimeLabel;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  positionSize: number;
  riskAmount: number;
  entryDate: string;
  entryBarIndex: number;
  currentMfePct: number;
  currentMaePct: number;
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  barByBarPnl: number[];
}

export interface PendingSignal {
  signalId: string;
  symbol: string;
  direction: TradeDirection;
  strategy: StrategyName;
  regime: MarketRegimeLabel;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  sector: string;
  entryZoneLow: number;
  entryZoneHigh: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  riskPerUnit: number;
  signalDate: string;
  signalBarIndex: number;
  barsWaited: number;
}

// ════════════════════════════════════════════════════════════════
//  14. AUDIT LOG ENTRY
// ════════════════════════════════════════════════════════════════

export type AuditAction = 'run_started' | 'run_completed' | 'run_failed'
  | 'signal_generated' | 'signal_expired' | 'signal_filtered'
  | 'entry_triggered' | 'exit_stop' | 'exit_target' | 'exit_expiry'
  | 'position_opened' | 'position_closed'
  | 'config_validated' | 'data_loaded' | 'warmup_validated'
  | 'metrics_computed' | 'calibration_computed' | 'persistence_completed'
  | 'simulation_completed' | 'outcomes_computed'
  | 'data_repair_applied' | 'data_rejected' | 'symbol_timeout'
  | 'signal_gen_error'
  | 'data_coverage_ok';

export interface RunStatusInfo {
  status: BacktestStatus;
  lastSuccessfulStep: string | null;
  errorMessage: string | null;
}

export interface BacktestAuditEntry {
  runId: string;
  timestamp: string;
  barIndex: number;
  action: AuditAction;
  symbol: string | null;
  message: string;
  payload: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════
//  15. API REQUEST/RESPONSE TYPES
// ════════════════════════════════════════════════════════════════

export interface BacktestRunRequest {
  config: BacktestRunConfig;
}

export interface BacktestRunResponse {
  runId: string;
  status: BacktestStatus;
  message: string;
}

export interface BacktestDetailResponse {
  run: BacktestRunRecord;
}

export interface BacktestTradesResponse {
  runId: string;
  trades: SimulatedTrade[];
  total: number;
}

export interface BacktestAnalyticsResponse {
  runId: string;
  summary: BacktestSummary;
  strategyBreakdown: StrategyBreakdownResult[];
  regimeBreakdown: RegimeBreakdownResult[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetric[];
}

export interface BacktestCalibrationResponse {
  runId: string;
  buckets: CalibrationBucketResult[];
}
