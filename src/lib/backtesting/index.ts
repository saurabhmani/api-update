// ════════════════════════════════════════════════════════════════
//  Quantorus365 Backtesting Engine — Public API
// ════════════════════════════════════════════════════════════════

// ── Core runners ───────────────────────────────────────────
export { runBacktest } from './runner/backtestRunner';
export type { BacktestRunResult } from './runner/backtestRunner';
export { persistFullRun } from './runner/runOrchestrator';
export type { OrchestratedResult } from './runner/runOrchestrator';
export { runBatchBacktests, generateParameterSweep } from './runner/runBatchBacktests';
export type { BatchConfig, BatchResult } from './runner/runBatchBacktests';
export { runWalkForward, generateWalkForwardFolds } from './runner/runWalkForward';
export type { WalkForwardConfig, WalkForwardResult } from './runner/runWalkForward';

// ── Dexter AI Integration ──────────────────────────────────
export { buildDexterOutput } from './api/dexterOutput';
export type { DexterOutput, DexterStrategyInsight, DexterRegimeInsight, DexterCalibrationWarning } from './api/dexterOutput';

// ── Configuration ──────────────────────────────────────────
export { DEFAULT_BACKTEST_CONFIG } from './config/defaults';

// ── Validation ─────────────────────────────────────────────
export { validateBacktestConfig, validateBar, validateDataSufficiency } from './utils/validation';

// ── Data provider ──────────────────────────────────────────
export { createHistoricalCandleProvider, preloadCandleData, getPostSignalCandles } from './data/historicalCandleProvider';

// ── Replay ─────────────────────────────────────────────────
export { createReplayClock, advanceClock, getCurrentDate, isWarmupComplete, getProgress, assertNoLookahead } from './replay/replayClock';
export type { ReplayClockState } from './replay/replayClock';
export { createRollingWindowStore } from './replay/rollingWindow';
export type { RollingWindowStore } from './replay/rollingWindow';
export { replaySignals, toPendingSignal } from './replay/signalReplay';
export { captureReplayContext, captureRelativeStrength, buildReplayContext } from './replay/contextReplay';
export type { ReplayContextSnapshot } from './replay/contextReplay';

// ── Simulation: Entry ──────────────────────────────────────
export { simulateEntry } from './simulation/entrySimulator';
export type { EntryMode, EntrySimResult } from './simulation/entrySimulator';

// ── Simulation: Stop + Target ──────────────────────────────
export { checkStopLoss } from './simulation/stopSimulator';
export type { StopCheckResult } from './simulation/stopSimulator';
export { checkTargets } from './simulation/targetSimulator';
export type { TargetCheckResult } from './simulation/targetSimulator';

// ── Simulation: Lifecycle ──────────────────────────────────
export { processPositionBar } from './simulation/tradeLifecycleSimulator';
export type { LifecycleStepResult } from './simulation/tradeLifecycleSimulator';
export { processSignalLifecycles, checkSignalExpiry, checkSignalInvalidation } from './simulation/signalLifecycleSimulator';
export type { SignalDisposition, SignalStepResult } from './simulation/signalLifecycleSimulator';

// ── Simulation: Original trade simulator ───────────────────
export { checkEntryTrigger, checkExit, updateExcursions, calculateBacktestPositionSize, closePosition } from './simulation/tradeSimulator';

// ── Utils ──────────────────────────────────────────────────
export { getIntraBarPricePath, wasLevelReached, whichLevelFirst } from './utils/barExecution';
export type { IntraBarAssumption } from './utils/barExecution';
export { applySlippage, totalSlippageCost } from './utils/slippage';
export { calculateTradeFees, quickFeeEstimate, DEFAULT_FEE_CONFIG } from './utils/fees';
export type { FeeConfig, FeeBreakdown } from './utils/fees';

// ── Metrics: Core ──────────────────────────────────────────
export { computeBacktestSummary, computeStrategyBreakdown, computeRegimeBreakdown } from './metrics/computeMetrics';

// ── Metrics: Specialized ───────────────────────────────────
export { computeMfeMaeStats } from './metrics/mfeMae';
export type { MfeMaeStats, ExcursionBucket } from './metrics/mfeMae';
export { computeTradeOutcomeStats, computeSignalOutcomes } from './metrics/outcomeMetrics';
export type { TradeOutcomeStats, OutcomeDistribution } from './metrics/outcomeMetrics';
export { computeExpectancy } from './metrics/expectancyMetrics';
export type { ExpectancyResult } from './metrics/expectancyMetrics';
export { computeCalibration, computeFullCalibrationMatrix, isModelCalibrated } from './metrics/calibrationMetrics';
export { computeDrawdownStats } from './metrics/drawdownMetrics';
export type { DrawdownStats, DrawdownPeriod } from './metrics/drawdownMetrics';
export { computeFullPerformanceReport } from './metrics/performanceMetrics';
export type { FullPerformanceReport } from './metrics/performanceMetrics';

// ── Analytics: Slicing ─────────────────────────────────────
export { analyzeByStrategy } from './analytics/byStrategy';
export type { StrategyAnalytics } from './analytics/byStrategy';
export { analyzeByRegime } from './analytics/byRegime';
export type { RegimeAnalytics } from './analytics/byRegime';
export { analyzeBySector } from './analytics/bySector';
export type { SectorAnalytics } from './analytics/bySector';
export { analyzeByConfidenceBucket, isConfidenceMonotonic } from './analytics/byConfidenceBucket';
export type { ConfidenceBucketAnalytics } from './analytics/byConfidenceBucket';
export { analyzeByRiskBand } from './analytics/byRiskBand';
export type { RiskBandAnalytics } from './analytics/byRiskBand';
export { analyzeByHoldingPeriod } from './analytics/byHoldingPeriod';
export type { HoldingPeriodAnalytics } from './analytics/byHoldingPeriod';

// ── Persistence ────────────────────────────────────────────
export { saveBacktestRun, loadBacktestRun, listBacktestRuns, loadBacktestTrades, loadEquityCurve } from './repository/persistence';
export { saveBacktestMetrics, saveCalibrationSnapshots, saveSignalOutcomes, saveBacktestSignals, loadBacktestMetrics, loadCalibrationSnapshots } from './repository/metricsPersistence';
export { AuditLogger } from './repository/auditLogger';

// ── Migration ──────────────────────────────────────────────
export { migrateBacktestTables, ensureBacktestTables } from './repository/migrate';

// ── Types ──────────────────────────────────────────────────
export type {
  BacktestRunConfig, BacktestRunRecord, BacktestStatus, BacktestSummary,
  HistoricalBar, ReplayContext,
  SimulatedSignal, SimulatedTrade, SignalOutcome,
  TradeDirection, TradeOutcome, ExitReason,
  EquityPoint, OpenPosition, PendingSignal,
  BacktestMetric, CalibrationBucketResult, CalibrationState,
  StrategyBreakdownResult, RegimeBreakdownResult,
  BacktestAuditEntry, AuditAction,
  BacktestRunRequest, BacktestRunResponse,
  BacktestDetailResponse, BacktestTradesResponse,
  BacktestAnalyticsResponse, BacktestCalibrationResponse,
} from './types';
