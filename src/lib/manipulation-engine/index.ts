// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Public API (Phase 1)
//
//  NOTE: this is a NEW subsystem at /src/lib/manipulation-engine/.
//  The older /src/lib/manipulation-detection/ still exists and is
//  untouched — both live in parallel until callers migrate.
// ════════════════════════════════════════════════════════════════

export * from './types';
export { THRESHOLDS, SUSPICION_BANDS, bandFromScore } from './constants/thresholds';
export { computeFeaturesForSeries } from './features/computeFeatures';
export { ALL_DETECTORS } from './detectors';
export { computeScore } from './scoring/computeScore';
export type { ScoreResult } from './scoring/computeScore';
export { scanSymbol, scanSymbolSeries } from './pipeline/runScan';
export type { ScanOptions } from './pipeline/runScan';
export {
  ensureManipulationEngineTables,
  migrateManipulationEngineTables,
} from './repository/migrate';
export {
  saveSnapshot, loadLatestSnapshot, loadSnapshotsForSymbol,
  loadEvents, loadSnapshotsByDate, saveSignalManipulationLink,
  saveDetectorResults, loadDetectorResults,
  saveManipulationPenalty, loadPenaltiesForSignal, loadRecentPenalties,
  loadSuspicionTrend, loadEventClustersBySymbol,
} from './repository/persistence';
export type { SuspicionTrendPoint, EventClusterRow } from './repository/persistence';
export {
  buildHookResult, getManipulationStatusForSymbol,
  shouldPenalizeSymbol, shouldRejectSymbol, getManipulationWarning,
} from './api/signalEngineHooks';
export {
  applyHookToSignal, applyManipulationPenalty, buildPenaltyRecord,
} from './api/applyManipulationPenalty';
export type { AppliedPenalty } from './api/applyManipulationPenalty';
export { deriveRiskLabels } from './scoring/riskLabels';

// ── Phase 3 ─────────────────────────────────────────────────────
export {
  decideActions, actionExplanation, DEFAULT_ACTION_RULES,
} from './actions/actionRegistry';
export type {
  ManipulationAction, ActionRule, ActionDecision,
} from './actions/actionRegistry';

export {
  evaluateWatchlists, diffWatchlistState,
} from './watchlists/watchlistEvaluator';
export type { WatchlistDecision, WatchlistChange } from './watchlists/watchlistEvaluator';
export {
  loadWatchlistForSymbol, loadWatchlist, loadAllWatchlists,
  applyWatchlistChanges, loadWatchlistHistory,
} from './watchlists/watchlistRepository';

export {
  topSuspiciousSymbols, eventDensityByWindow, sectorAnomalyConcentration,
  winRateByScoreBucket, strategyPerfFiltered, eventTypeHistogram,
  bucketTradesByScore, bandToMinScore,
} from './analytics/manipulationAnalytics';
export type {
  TopSuspiciousRow, EventDensityRow, SectorAnomalyRow,
  BucketPerformance, StrategyPerfRow,
} from './analytics/manipulationAnalytics';

export {
  buildCalibrationSnapshots, persistCalibrationSnapshots, loadCalibrationSnapshots,
} from './analytics/calibration';
export type { CalibrationInputTrade } from './analytics/calibration';

export { buildBacktestTag, tagFromSnapshot } from './backtest/tagSignals';
export type { BacktestTag } from './backtest/tagSignals';
