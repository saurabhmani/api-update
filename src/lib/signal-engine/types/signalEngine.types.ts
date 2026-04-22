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

export type EntryType = 'breakout_confirmation';

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
  | 'weak_trend_breakdown';

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

export type SignalType = 'bullish_breakout' | 'bullish_pullback' | 'bearish_breakdown' | 'mean_reversion_bounce' | 'momentum_continuation' | 'bullish_divergence' | 'volume_climax_reversal' | 'gap_continuation' | 'range_breakout' | 'ema_crossover' | 'oversold_bounce' | 'overbought_reversal' | 'weak_trend_breakdown';
export type SignalSubtype = 'fresh_breakout' | 'continuation' | 'pullback_entry' | 'reversal_bounce' | 'breakdown' | 'momentum_ride' | 'divergence_reversal' | 'climax_reversal' | 'gap_and_go' | 'range_expansion' | 'ema_cross' | 'oversold_reversal' | 'overbought_reversal_entry' | 'weak_trend_entry';
// Both new bearish strategies reuse 'enter_short' — saveSignals.ts
// keys the BUY/SELL direction ONLY off enter_short (line 166). So we
// don't introduce new action values: any row with enter_short is
// classified as SELL direction, cleanly handling all three bearish
// strategies with no saveSignals change.
export type SignalAction = 'enter_on_strength' | 'enter_on_pullback' | 'enter_short' | 'enter_on_bounce' | 'enter_on_momentum' | 'enter_on_divergence' | 'enter_on_climax' | 'enter_on_gap' | 'enter_on_breakout' | 'enter_on_crossover' | 'enter_on_oversold';
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
