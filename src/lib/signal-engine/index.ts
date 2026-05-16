// ════════════════════════════════════════════════════════════════
//  Quantorus365 Signal Engine — Public API
// ════════════════════════════════════════════════════════════════

// Phase 1
export { generatePhase1Signals } from './pipeline/generatePhase1Signals';
export type { CandleProvider, PipelineResult } from './pipeline/generatePhase1Signals';

// Phase 2
export { generatePhase2Signals } from './pipeline/generatePhase2Signals';
// Phase2PipelineResult exported from types below
export { runAllStrategies } from './strategy-engine/runStrategies';
export { computeRelativeStrength, defaultRelativeStrength, computeEnhancedRelativeStrength } from './context/relativeStrength';
export { detectEnhancedRegime } from './regime/detectMarketRegime';
export { resolveConflicts } from './strategy-engine/resolveConflicts';
export { STRATEGY_REGISTRY, isStrategyAllowedInRegime, getStrategiesForRegime } from './strategies/strategyRegistry';
export { buildSectorContextFromStock, defaultSectorContext } from './context/sectorContext';
export { scoreForStrategy } from './scoring/strategyScorers';
export { saveStrategyBreakdowns, saveConflictResolution, migratePhase2Tables } from './repository/saveStrategyBreakdowns';

// Phase 3
export { generatePhase3Signals } from './pipeline/generatePhase3Signals';
export type { Phase3Result } from './pipeline/generatePhase3Signals';
export { calculatePositionSize } from './position-sizing/positionSizer';
export { evaluatePortfolioFit } from './portfolio-fit/evaluatePortfolioFit';
export { evaluateExecutionReadiness } from './execution/executionReadiness';
export { computePhase3Risk } from './risk/phase3Risk';
export { createLifecycle, transitionLifecycle, resolveInitialState, isExpired } from './lifecycle/signalLifecycle';
export { DEFAULT_PHASE3_CONFIG, getSector } from './constants/phase3.constants';
export { buildPhase3TradePlanForStrategy } from './trade-plan/buildTradePlan';
export { pearsonCorrelation, buildCorrelationMatrix, evaluateCorrelationPenalty } from './correlation/correlationEngine';

// Phase 4
export { generatePhase4Signals } from './pipeline/generatePhase4Signals';
export type { Phase4Result } from './pipeline/generatePhase4Signals';
export { buildExplanation, buildTraderNarrative } from './ai-explain/buildExplanation';
export { buildMacroContext, defaultNewsContext, computeEventRisk } from './context/macroContext';
export { computeContextualModifiers } from './context/contextualModifiers';
export { computeFreshness } from './freshness/signalDecay';
export { evaluateOutcome, aggregatePerformance, calibrateConfidence, computeAdaptiveRecommendation, defaultFeedbackState } from './feedback/outcomeTracker';
export { createMemoryEntry, buildPortfolioCommentary } from './memory/decisionMemory';
export { saveOutcome, saveExplanation, saveDecisionMemory, loadFeedbackState, migratePhase4Tables } from './repository/savePhase4Artifacts';

// Shared
export { rankSignals } from './pipeline/rankSignals';
export { detectMarketRegime } from './regime/detectMarketRegime';
export { evaluateBullishBreakout } from './strategies/bullishBreakout';
export { evaluateBullishPullback } from './strategies/bullishPullback';
export { evaluateBearishBreakdown } from './strategies/bearishBreakdown';
export { evaluateMeanReversionBounce } from './strategies/meanReversionBounce';
export { evaluateMomentumContinuation } from './strategies/momentumContinuation';
export { evaluateBullishDivergence } from './strategies/bullishDivergence';
export { evaluateVolumeClimaxReversal } from './strategies/volumeClimaxReversal';
export { evaluateGapContinuation } from './strategies/gapContinuation';
export { buildSignalFeatures } from './features/buildSignalFeatures';
export { scoreConfidence, scoreConfidenceForStrategy } from './scoring/confidenceScorer';
export { scoreRisk } from './scoring/riskScorer';
export { buildTradePlan, buildTradePlanForStrategy } from './trade-plan/buildTradePlan';
export { buildReasons } from './explain/buildReasons';
export { buildWarnings } from './explain/buildWarnings';
export { saveSignals, getLatestSignals } from './repository/saveSignals';
export { DEFAULT_PHASE1_CONFIG } from './constants/signalEngine.constants';

export type {
  Candle,
  MarketRegime,
  MarketRegimeLabel,
  EnhancedMarketRegime,
  SignalFeatures,
  TrendFeatures,
  MomentumFeatures,
  VolumeFeatures,
  VolatilityFeatures,
  StructureFeatures,
  RelativeStrengthFeatures,
  ConfidenceBreakdown,
  ConfidenceBand,
  RiskBreakdown,
  RiskBand,
  TradePlan,
  QuantSignal,
  Phase1Config,
  SignalType,
  SignalAction,
  SignalStatus,
  StrategyMatchResult,
  StrategyName,
  StrategyCandidate,
  SignalSubtype,
  MarketContextTag,
  StrengthTag,
  Phase2Signal,
  Phase2PipelineResult,
  StrategyRegistryEntry,
  StrategyDirection,
  SectorContext,
  SectorTrendLabel,
  EnhancedRelativeStrength,
  ConflictResolution,
  StrategyBreakdown,
} from './types/signalEngine.types';

export type {
  Phase3TradePlan,
  PositionSizingInput,
  PositionSizingResult,
  PortfolioSnapshot,
  PortfolioPosition,
  PortfolioFitResult,
  CorrelationSnapshot,
  SectorExposureSnapshot,
  DirectionExposureSnapshot,
  ExecutionReadiness,
  ExecutionStatus,
  ActionTag,
  ApprovalDecision,
  Phase3RiskBreakdown,
  SignalLifecycle,
  LifecycleState,
  ExecutableSignal,
  Phase3Config,
} from './types/phase3.types';

export type {
  AIExplanation,
  TraderNarrative,
  NewsContext,
  MacroContext,
  EventRiskSnapshot,
  EventTag,
  ContextualModifierBreakdown,
  SignalFreshness,
  SignalOutcome,
  StrategyPerformanceSnapshot,
  ConfidenceCalibrationSnapshot,
  AdaptiveRecommendation,
  DecisionMemoryEntry,
  PortfolioCommentary,
  FeedbackState,
  Phase4SignalEnvelope,
} from './types/phase4.types';
