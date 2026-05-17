// ════════════════════════════════════════════════════════════════
//  Quantorus365 Signal Engine — Phase 1 Types
// ════════════════════════════════════════════════════════════════

// ── Candle ────────────────────────────────────────────────────
export interface Candle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Market Regime ────────────────────────────────────────────
export type MarketRegimeLabel =
  | 'Strong Bullish'
  | 'Bullish'
  | 'Sideways'
  | 'Weak'
  | 'Bearish'
  | 'High Volatility Risk';

export interface MarketRegime {
  label: MarketRegimeLabel;
  allowBullishSignals: boolean;
  details: {
    closeVsEma20: number;
    closeVsEma50: number;
    closeVsEma200: number;
    ema20VsEma50: number;
    ema50VsEma200: number;
    rsi: number;
    atrPct: number;
  };
}

// ── Feature Groups ───────────────────────────────────────────

export interface TrendFeatures {
  close: number;
  open: number;
  ema9: number;
  ema21: number;
  ema20: number;
  ema50: number;
  ema200: number;
  sma200: number;
  closeAbove20Ema: boolean;
  closeAbove50Ema: boolean;
  closeAbove200Ema: boolean;
  ema20Above50: boolean;
  ema50Above200: boolean;
  distanceFrom20EmaPct: number;
  distanceFrom50EmaPct: number;
}

export interface MomentumFeatures {
  rsi14: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  roc5: number;
  roc20: number;
  stochasticK: number;
  stochasticD: number;
  adx: number;
  bullishDivergence: boolean;
  bearishDivergence: boolean;
}

export interface VolumeFeatures {
  volume: number;
  avgVolume20: number;
  volumeVs20dAvg: number;
  breakoutVolumeRatio: number;
  obv: number;
  obvSlope: number;
  vwap: number;
  volumeClimaxRatio: number;
}

export interface VolatilityFeatures {
  atr14: number;
  atrPct: number;
  dailyRangePct: number;
  gapPct: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerWidth: number;
  bollingerPctB: number;
  squeezed: boolean;
}

export interface StructureFeatures {
  recentResistance20: number;
  recentSupport20: number;
  breakoutDistancePct: number;
  distanceToResistancePct: number;
  distanceToSupportPct: number;
  recentHigh20: number;
  recentLow20: number;
  isInsideDay: boolean;
  rangeCompressionRatio: number;
  consecutiveHigherLows: number;
  consecutiveLowerHighs: number;
}

export interface ContextFeatures {
  marketRegime: MarketRegimeLabel;
  liquidityPass: boolean;
}

export interface SignalFeatures {
  trend: TrendFeatures;
  momentum: MomentumFeatures;
  volume: VolumeFeatures;
  volatility: VolatilityFeatures;
  structure: StructureFeatures;
  context: ContextFeatures;
}

// ── Confidence ───────────────────────────────────────────────

export type ConfidenceBand =
  | 'High Conviction'
  | 'Actionable'
  | 'Watchlist'
  | 'Avoid';

export interface ConfidenceBreakdown {
  trendScore: number;
  momentumScore: number;
  volumeScore: number;
  structureScore: number;
  contextScore: number;
  rawScore: number;
  penaltyScore: number;
  finalScore: number;
  band: ConfidenceBand;
}

// ── Risk ─────────────────────────────────────────────────────

export type RiskBand =
  | 'Low Risk'
  | 'Moderate Risk'
  | 'Elevated Risk'
  | 'High Risk';

export interface RiskBreakdown {
  atrRisk: number;
  gapRisk: number;
  stopDistanceRisk: number;
  overextensionRisk: number;
  liquidityRisk: number;
  candleVolatilityRisk: number;
  regimeRisk: number;
  totalScore: number;
  band: RiskBand;
}

// ── Trade Plan ───────────────────────────────────────────────
//
// Phase-1 strategy-specific entry types. Every strategy must pick the
// `EntryType` that matches its mechanic so the trade plan card surfaces
// honest copy ("pullback_entry" / "mean_reversion_entry" / etc.)
// instead of stamping "breakout_confirmation" on every plan.
//
// `strategy_confirmation_entry` is the explicit fallback for any new
// strategy that hasn't yet had its entry mechanic mapped — callers
// should log a warning when they emit it. The full strategy → entry
// map lives in src/lib/signal-engine/strategies/strategyRegistry.ts
// so wire consumers can read a single authority.
export type EntryType =
  // Phase 1:
  | 'breakout_confirmation'
  | 'range_breakout_confirmation'
  | 'trend_crossover_entry'
  | 'momentum_continuation_entry'
  | 'gap_continuation_entry'
  | 'pullback_entry'
  | 'mean_reversion_entry'
  | 'oversold_recovery_entry'
  | 'divergence_confirmation_entry'
  | 'volume_climax_reversal_entry'
  | 'breakdown_confirmation'
  | 'overbought_reversal_entry'
  | 'weak_trend_breakdown_entry'
  | 'strategy_confirmation_entry'
  // Phase 4A:
  | 'failed_breakout_reversal_entry'
  | 'bearish_pullback_rejection_entry'
  | 'volatility_squeeze_breakout_entry'
  // Phase 4B (intraday — registered for completeness):
  | 'multi_timeframe_confirmation_entry'
  | 'vwap_reclaim_entry'
  | 'vwap_rejection_entry'
  | 'opening_range_breakout_entry'
  | 'opening_range_breakdown_entry';

export interface TradePlan {
  entry: {
    type: EntryType;
    zoneLow: number;
    zoneHigh: number;
  };
  stopLoss: number;
  targets: {
    target1: number;
    target2: number;
  };
  rewardRiskApprox: number;
}

// ── Signal Reasons / Warnings ────────────────────────────────

export interface SignalReason {
  type: 'reason' | 'warning';
  message: string;
}

// ── Final Signal Object ──────────────────────────────────────

// ── Relative Strength ───────────────────────────────────────

export interface RelativeStrengthFeatures {
  rsVsIndex: number;
  rsVsSector: number;
  sectorStrengthScore: number;
}

// ── Enhanced Market Regime (Phase 2) ────────────────────────

export interface EnhancedMarketRegime extends MarketRegime {
  strength: number;
  volatilityRegime: 'Low' | 'Normal' | 'Elevated' | 'Extreme';
  trendSlope: number;
  confidence: number;
}

// ── Strategy System ─────────────────────────────────────────

export type StrategyName =
  // ── Phase 1: original 13 ─────────────────────────────────
  | 'bullish_breakout'
  | 'bullish_pullback'
  | 'bearish_breakdown'
  | 'mean_reversion_bounce'
  | 'momentum_continuation'
  | 'bullish_divergence'
  | 'volume_climax_reversal'
  | 'gap_continuation'
  | 'range_breakout'
  | 'ema_crossover'
  | 'oversold_bounce'
  | 'overbought_reversal'
  | 'weak_trend_breakdown'
  // ── Phase 4A: swing strategies (EOD-data based) ──────────
  | 'failed_breakout_reversal'
  | 'bearish_pullback_rejection'
  | 'volatility_squeeze_breakout'
  // ── Phase 4B: confirmation / intraday-aware strategies ──
  // These require intraday candles or weekly/intraday alignment
  // that the current EOD warehouse cannot provide. They are
  // registered with `requiresIntradayData: true` so the detector
  // returns INSUFFICIENT_DATA cleanly instead of fabricating
  // signals.
  | 'multi_timeframe_alignment'
  | 'vwap_reclaim_long'
  | 'vwap_rejection_short'
  | 'opening_range_breakout'
  | 'opening_range_breakdown';

// Canonical list of strategies that produce SHORT/SELL trades. The
// saveSignals direction-mapper keys off `action === 'enter_short'`,
// but internal pipeline steps (Phase 3 direction, trade-plan short
// logic, scoring) want to branch on strategy name. Export a shared
// Set so every caller uses the same truth — avoids the pre-Nov 2026
// bug where buildTradePlan's `isShort = strategy === 'bearish_breakdown'`
// silently mis-classified new bearish strategies as long.
export const BEARISH_STRATEGIES: ReadonlySet<StrategyName> = new Set<StrategyName>([
  'bearish_breakdown',
  'overbought_reversal',
  'weak_trend_breakdown',
  // Phase 4A:
  'failed_breakout_reversal',
  'bearish_pullback_rejection',
  // Phase 4B:
  'vwap_rejection_short',
  'opening_range_breakdown',
]);

export interface StrategyMatchResult {
  matched: boolean;
  rejectionReason?: string;
}

export interface StrategyCandidate {
  strategy: StrategyName;
  features: SignalFeatures;
  relativeStrength: RelativeStrengthFeatures;
  confidence: ConfidenceBreakdown;
  risk: RiskBreakdown;
  tradePlan: TradePlan;
  reasons: string[];
  warnings: string[];
}

// ── Signal Classification ───────────────────────────────────

export type SignalType =
  // Phase 1:
  | 'bullish_breakout' | 'bullish_pullback' | 'bearish_breakdown' | 'mean_reversion_bounce'
  | 'momentum_continuation' | 'bullish_divergence' | 'volume_climax_reversal' | 'gap_continuation'
  | 'range_breakout' | 'ema_crossover' | 'oversold_bounce' | 'overbought_reversal'
  | 'weak_trend_breakdown'
  // Phase 4:
  | 'failed_breakout_reversal' | 'bearish_pullback_rejection' | 'volatility_squeeze_breakout'
  | 'multi_timeframe_alignment' | 'vwap_reclaim_long' | 'vwap_rejection_short'
  | 'opening_range_breakout' | 'opening_range_breakdown';

export type SignalSubtype =
  // Phase 1:
  | 'fresh_breakout' | 'continuation' | 'pullback_entry' | 'reversal_bounce' | 'breakdown'
  | 'momentum_ride' | 'divergence_reversal' | 'climax_reversal' | 'gap_and_go'
  | 'range_expansion' | 'ema_cross' | 'oversold_reversal' | 'overbought_reversal_entry'
  | 'weak_trend_entry'
  // Phase 4:
  | 'failed_breakout' | 'bearish_pullback' | 'volatility_squeeze'
  | 'multi_timeframe_align' | 'vwap_reclaim' | 'vwap_rejection'
  | 'opening_range_break' | 'opening_range_breakdown_sub';
// Both new bearish strategies reuse 'enter_short' — saveSignals.ts
// keys the BUY/SELL direction ONLY off enter_short (line 166). So we
// don't introduce new action values: any row with enter_short is
// classified as SELL direction, cleanly handling all three bearish
// strategies with no saveSignals change.
export type SignalAction =
  // Phase 1:
  | 'enter_on_strength' | 'enter_on_pullback' | 'enter_short' | 'enter_on_bounce'
  | 'enter_on_momentum' | 'enter_on_divergence' | 'enter_on_climax' | 'enter_on_gap'
  | 'enter_on_breakout' | 'enter_on_crossover' | 'enter_on_oversold'
  // Phase 4:
  | 'enter_on_confirmation' | 'enter_on_intraday_break' | 'avoid_long';
export type SignalStatus = 'active' | 'watchlist' | 'expired' | 'invalidated';
export type MarketContextTag = 'Bullish' | 'Neutral' | 'Weak';
export type StrengthTag = 'High Conviction' | 'Actionable' | 'Watchlist' | 'Avoid';

// ── Final Signal Object ─────────────────────────────────────

export interface QuantSignal {
  symbol: string;
  timeframe: 'daily';
  signalType: SignalType;
  signalSubtype: SignalSubtype;
  action: SignalAction;
  marketRegime: MarketRegimeLabel;
  marketContextTag: MarketContextTag;
  strengthTag: StrengthTag;
  strategyName: string;
  strategyConfidence: number;
  contextScore: number;

  confidenceScore: number;
  confidenceBand: ConfidenceBand;

  riskScore: number;
  riskBand: RiskBand;

  entry: {
    type: EntryType;
    zoneLow: number;
    zoneHigh: number;
  };
  stopLoss: number;
  targets: {
    target1: number;
    target2: number;
  };
  rewardRiskApprox: number;

  reasons: string[];
  warnings: string[];

  features: SignalFeatures;
  relativeStrength: RelativeStrengthFeatures;
  confidenceBreakdown: ConfidenceBreakdown;
  riskBreakdown: RiskBreakdown;

  status: SignalStatus;
  rank?: number;
  signalRank?: number;
  generatedAt: string;

  // ── Phase-4 scoring pass-through (optional, additive) ─────────
  // Populated by Phase 3 via runPhase4Scoring; consumed by
  // saveSignals to write composite_final_score / classification /
  // factor_scores_json to q365_signals. NULL when an older caller
  // built the QuantSignal without invoking the Phase-4 adapter.
  phase4FinalScore?:     number;
  phase4Classification?: import('../scoring/phase4FactorAdapter').FinalScoreBand;
  phase4FactorScores?: {
    strategy_quality:     number;
    trend_alignment:      number;
    momentum:             number;
    volume_confirmation:  number;
    risk_reward:          number;
    liquidity:            number;
    market_regime:        number;
    portfolio_fit:        number;
  };

  // ── Phase-11 unified row block (optional, additive) ───────────
  // Populated by runPhase11Pipeline (stress + live + sizing +
  // explanation) inside generatePhase4Signals. Consumed by
  // saveSignals to write the eight new q365_signals columns +
  // four JSON blobs added by the Phase-11 migration. Every field
  // is optional so older callers that don't run the Phase-11
  // pipeline still produce valid INSERTs (columns stay NULL).
  phase11StressSurvivalScore?:   number | null;
  phase11LiveValid?:             boolean | null;
  phase11RecommendedQuantity?:   number;
  phase11RecommendedCapital?:    number;
  phase11RejectionCodes?:        string[];
  phase11RejectionReasons?:      string[];
  phase11LiveValidationReasons?: string[];
  phase11Explanation?: {
    summary_reason:             string;
    factor_score_explanation:   string;
    risk_explanation:           string;
    portfolio_explanation:      string;
    stress_explanation:         string;
    rejection_explanation:      string;
    final_decision_explanation: string;
  };
}

// ── Pipeline Config ──────────────────────────────────────────

export interface Phase1Config {
  universe: string[];
  benchmarkSymbol: string;
  timeframe: 'daily';
  minCandleCount: number;
  breakoutBuffer: number;
  minAvgVolume: number;
  minPrice: number;
  minConfidenceToSave: number;
}

// ════════════════════════════════════════════════════════════════
//  Phase 2 Types — Strategy Context + Sector + Conflict
// ════════════════════════════════════════════════════════════════

// ── Strategy Registry ──────────────────────────────────────
export type StrategyDirection = 'long' | 'short' | 'neutral';

// Phase-1 stabilization spec — every strategy is mapped to one of
// these categories so the API/UI can group setups cleanly without
// hardcoding strategy names downstream.
export type StrategyCategory =
  | 'breakout'
  | 'trend_following'
  | 'momentum'
  | 'pullback'
  | 'mean_reversion'
  | 'reversal'
  | 'breakdown'
  | 'risk_defense'
  // Phase 4 additions:
  | 'confirmation'
  | 'intraday_confirmation'
  | 'intraday_breakout'
  | 'intraday_breakdown';

// Risk profile is the operator-facing "how aggressive is this setup"
// dial. Used in trade plan + opportunity cards. Internal scoring still
// reads from confidence/risk breakdowns — this is a display hint only.
export type StrategyRiskProfile = 'conservative' | 'moderate' | 'moderate_high' | 'high';

export interface StrategyRegistryEntry {
  strategyId: StrategyName;
  displayName: string;
  direction: StrategyDirection;
  allowedRegimes: MarketRegimeLabel[];
  blockedRegimes: MarketRegimeLabel[];
  minAdx?: number;
  idealRsiRange: [number, number];
  minVolumeExpansion?: number;
  defaultConfidenceWeight: number;

  // ── Phase-1 standardized metadata ─────────────────────────
  // These are all required so a new strategy can't ship without
  // declaring its category, entry type, and operator-facing copy.
  // The trade-plan builder and the API response reader BOTH source
  // from these fields — single authority, no drift.
  category:           StrategyCategory;
  entryType:          EntryType;
  riskProfile:        StrategyRiskProfile;
  timeframe:          'intraday' | 'swing' | 'positional' | 'daily';
  signalType:         StrategyName;            // mirror of strategyId for wire-facing readers
  /** Operator-facing one-liner shown on opportunity cards / signal
   *  details. Keep institutional — no raw RSI/ADX numbers. */
  explanationTemplate: string;
  /** Plain-language invalidation rule. Mirrors stop / structure logic. */
  invalidationLogic:   string;
  /** Convenience array of regimes where this strategy works best. */
  idealMarketRegime:   MarketRegimeLabel[];
  /** Phase 4 — true for strategies that need data we don't have on the
   *  EOD warehouse (intraday candles, weekly aggregates, VWAP, etc.).
   *  Detection MUST return INSUFFICIENT_DATA on these — never fake. */
  requiresIntradayData?: boolean;
  /** Phase 4 — confirmation-only strategies that boost / contradict
   *  other signals rather than emitting standalone trades. */
  isConfirmationOnly?:   boolean;
}

// ── Sector Context ─────────────────────────────────────────
export type SectorTrendLabel = 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining';

export interface SectorContext {
  sector: string;
  sectorStrengthScore: number;
  sectorTrendLabel: SectorTrendLabel;
  sectorRoc5: number;
  sectorRoc20: number;
  stockCountInSector: number;
}

// ── Enhanced Relative Strength (multi-period) ──────────────
export interface EnhancedRelativeStrength extends RelativeStrengthFeatures {
  rsVsIndex5d: number;
  rsVsIndex20d: number;
  rsVsSector5d: number;
  rsVsSector20d: number;
  rsTrend: 'improving' | 'stable' | 'deteriorating';
  sectorTrendLabel: SectorTrendLabel;
}

// ── Conflict Resolution ────────────────────────────────────
export interface ConflictResolution {
  symbol: string;
  winningStrategy: StrategyName;
  winningScore: number;
  losingStrategies: {
    strategy: StrategyName;
    score: number;
    suppressionReason: string;
  }[];
  hadDirectionConflict: boolean;
  resolvedAt: string;
}

// ── Strategy Breakdown (for persistence) ───────────────────
export interface StrategyBreakdown {
  strategyName: StrategyName;
  matched: boolean;
  confidenceScore: number;
  riskScore: number;
  regimeFit: number;
  rsAlignment: number;
  sectorFit: number;
  structuralQuality: number;
  rejectionReason?: string;
}

// ── Phase 2 Signal (extends QuantSignal) ───────────────────
export interface Phase2Signal extends QuantSignal {
  sectorContext: SectorContext;
  enhancedRs: EnhancedRelativeStrength;
  strategyBreakdowns: StrategyBreakdown[];
  conflictResolution?: ConflictResolution;
  freshnessTag: 'fresh' | 'aging' | 'stale';
}

// ── Phase 2 Pipeline Result ────────────────────────────────
export interface Phase2PipelineResult {
  regime: EnhancedMarketRegime;
  signals: Phase2Signal[];
  scanned: number;
  matched: number;
  conflicts: ConflictResolution[];
  rejected: { symbol: string; strategy?: string; reason: string }[];
}
