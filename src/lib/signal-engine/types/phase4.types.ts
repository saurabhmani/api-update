// ════════════════════════════════════════════════════════════════
//  Phase 4 Types — AI Intelligence Layer + Feedback Loop
// ════════════════════════════════════════════════════════════════

// ── AI Explanation ──────────────────────────────────────────
export interface AIExplanation {
  summary: string;
  whyNow: string;
  decisionNarrative: string;
  traderGuidance: string[];
  riskHighlights: string[];
  whatWouldInvalidate: string[];
  whyNotOversize: string;
}

// ── Trader Narrative ────────────────────────────────────────
export interface TraderNarrative {
  shortSummary: string;
  fullNarrative: string;
  guidanceBullets: string[];
  invalidationSummary: string;
}

// ── News Context ────────────────────────────────────────────
//
// NUMERIC CONTRACT: All values consumed by the signal engine
// are 0-1 unless explicitly documented otherwise.
// freshnessHours remains in raw hours.
// sentimentScore is -1 to +1.
//
export type NewsBias = 'positive' | 'neutral' | 'negative';

/** Source class — where the news originated from. */
export type NewsSourceClass = 'official' | 'media' | 'deals' | 'social' | 'unknown';

/**
 * Summary of the 7-dimension scoring breakdown from the news engine.
 * All dimension scores are 0-1 (normalized from the 0-100 internal scale).
 */
export interface NewsScoreCardSummary {
  sourceReliability: number;           // 0-1 (trust dimension)
  recency: number;                     // 0-1 (freshness dimension)
  sentiment: number;                   // -1 to +1 (directional)
  novelty: number;                     // 0-1
  directness: number;                  // 0-1
  entityConfidence: number;            // 0-1
  manipulationRisk: number;            // 0-1
  finalSymbolImpact: number;           // 0-1 (composite)
  finalEventRisk: number;              // 0-1 (composite)
}

/**
 * Structured impact breakdown from the news engine.
 * Exposes symbol/sector/market impacts and penalties.
 */
export interface NewsImpactBreakdown {
  symbolImpact: number;                // 0-1
  sectorImpact: number;               // 0-1
  marketImpact: number;                // 0-1
  confidencePenalty: number;           // magnitude of negative confidence modifier (0-8)
  riskPenalty: number;                 // additive risk penalty (0-10)
  narrativeSummary: string;            // one-line human summary
}

export interface NewsContext {
  bias: NewsBias;
  strength: number;                    // 0-1
  freshnessHours: number;
  sourceConfidence: number;            // 0-1
  eventTags: string[];
  headline: string | null;
  // ── Enriched fields (populated by news-engine impact layer) ──
  symbolImpactScore?: number;          // 0-1
  sectorImpactScore?: number;          // 0-1
  marketImpactScore?: number;          // 0-1
  eventRiskScore?: number;             // 0-1
  manipulationSuspicion?: number;      // 0-1
  noveltyScore?: number;               // 0-1
  directnessScore?: number;            // 0-1
  sentimentScore?: number;             // -1 to +1
  eventType?: string;
  sourceTier?: string;
  entityConfidence?: number;           // 0-1
  eventId?: string;
  sourceClass?: NewsSourceClass;
  // ── Structured score breakdown (Phase 3 scoreCard + impact) ──
  scoreCard?: NewsScoreCardSummary;
  impactBreakdown?: NewsImpactBreakdown;
}

// ── Macro Context ───────────────────────────────────────────
export type MarketTone = 'strongly_constructive' | 'constructive' | 'neutral' | 'cautious' | 'hostile';
export type RiskMode = 'risk_on' | 'moderate_risk_on' | 'neutral' | 'risk_off';

export interface MacroContext {
  marketTone: MarketTone;
  riskMode: RiskMode;
  volatilityState: string;
  sectorLeadership: string[];
  macroEventProximity: 'none' | 'low' | 'moderate' | 'high';
}

// ── Event Risk ──────────────────────────────────────────────
export type EventTag =
  | 'earnings_within_3_days'
  | 'management_event'
  | 'policy_decision_today'
  | 'macro_data_release_today'
  | 'regulatory_decision'
  | 'corporate_action'
  | 'sudden_news_spike'
  | 'none';

export interface EventRiskSnapshot {
  eventRiskScore: number;     // 0-100
  eventRiskBand: 'low' | 'moderate' | 'elevated' | 'high';
  eventRiskPenalty: number;
  eventTags: EventTag[];
  comment: string;
}

// ── Contextual Modifiers ────────────────────────────────────
export interface ContextualModifierBreakdown {
  newsModifier: number;
  macroModifier: number;
  eventRiskPenalty: number;
  sectorNarrativeModifier: number;
  strategyFitModifier: number;
  freshnessPenalty: number;
  feedbackCalibrationModifier: number;
  rawTotal: number;
  cappedAdaptiveAdjustment: number;   // bounded ±10
  originalConfidence: number;
  finalAdjustedConfidence: number;
}

// ── Signal Freshness ────────────────────────────────────────
export type DecayState = 'fresh' | 'actionable_but_aging' | 'stale' | 'expired';
export type UrgencyTag = 'high' | 'normal' | 'low';

export interface SignalFreshness {
  ageBars: number;
  ageHours: number;
  freshnessScore: number;     // 0-100
  decayState: DecayState;
  urgencyTag: UrgencyTag;
  priceDriftPct: number;      // how far price moved since signal
}

// ── Signal Outcome ──────────────────────────────────────────
export type OutcomeLabel =
  | 'good_followthrough'
  | 'partial_success'
  | 'stopped_out'
  | 'stale_no_trigger'
  | 'expired'
  | 'ambiguous';

export interface SignalOutcome {
  signalId: number;
  entryTriggered: boolean;
  barsToEntry: number | null;
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  stopHit: boolean;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  /** Profit/loss in R-multiples (risk units). -1R = stopped out, +1R = target1, +2R = target2. */
  pnlR: number;
  returnAtBar5Pct: number | null;
  returnAtBar10Pct: number | null;
  outcomeLabel: OutcomeLabel;
  evaluatedAt: string;
}

// ── Strategy Performance ────────────────────────────────────
export type EnvironmentFit = 'excellent' | 'good' | 'moderate' | 'poor' | 'insufficient_data';

export interface StrategyPerformanceSnapshot {
  strategyName: string;
  regime: string;
  volatilityState: string;
  sector: string | null;
  sampleSize: number;
  winRate: number;
  target1HitRate: number;
  /** Average profit/loss in R-multiples across all outcomes. */
  avgPnlR: number;
  avgMFE: number;
  avgMAE: number;
  environmentFit: EnvironmentFit;
}

// ── Confidence Calibration ──────────────────────────────────
export type CalibrationState = 'well_calibrated' | 'slightly_overconfident' | 'overconfident' | 'underconfident' | 'insufficient_data';

export interface ConfidenceCalibrationSnapshot {
  bucket: string;             // e.g. '70_79'
  sampleSize: number;
  target1HitRate: number;
  avgMFE: number;
  calibrationState: CalibrationState;
}

// ── Adaptive Recommendation ─────────────────────────────────
export interface AdaptiveRecommendation {
  strategyEnvironmentFit: EnvironmentFit;
  recommendedConfidenceModifier: number;
  reason: string;
  sampleSize: number;
  evidenceStrength: 'strong' | 'moderate' | 'weak';
}

// ── Decision Memory ─────────────────────────────────────────
export interface DecisionMemoryEntry {
  signalId: number;
  stage: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Portfolio Commentary ────────────────────────────────────
export interface PortfolioCommentary {
  marketToneSummary: string;
  clusterRiskSummary: string;
  capitalDeploymentNote: string;
  watchlistNote: string;
  topOpportunitiesNote: string;
}

// ── Feedback State (attached to signal) ─────────────────────
export interface FeedbackState {
  strategyRecentWinRate: number | null;
  strategyEnvironmentFit: EnvironmentFit;
  confidenceCalibrationState: CalibrationState;
}

// ── Phase 4 Signal Envelope ─────────────────────────────────
export interface Phase4SignalEnvelope {
  // Base signal fields
  symbol: string;
  signalType: string;
  signalSubtype: string;
  marketRegime: string;

  confidenceScore: number;
  adjustedConfidenceScore: number;
  confidenceBand: string;

  riskScore: number;

  // Phase 3 components
  tradePlan: import('../types/phase3.types').Phase3TradePlan;
  positionSizing: import('../types/phase3.types').PositionSizingResult;
  portfolioFit: import('../types/phase3.types').PortfolioFitResult;
  executionReadiness: import('../types/phase3.types').ExecutionReadiness;

  // Phase 4 intelligence
  macroContext: MacroContext;
  newsContext: NewsContext;
  eventRisk: EventRiskSnapshot;
  contextualModifiers: ContextualModifierBreakdown;
  aiExplanation: AIExplanation;
  traderNarrative: TraderNarrative;
  freshness: SignalFreshness;
  feedbackState: FeedbackState;

  // Lifecycle
  lifecycleStatus: string;

  // ── Enriched news score breakdown (Phase 5) ──────────────────
  /** Full 7-dimension score card from news scoring engine (all 0-1). */
  scoreCard?: NewsScoreCardSummary;
  /** Structured impact breakdown (symbol/sector/market + penalties). */
  impactBreakdown?: NewsImpactBreakdown;

  // Standard
  reasons: string[];
  warnings: string[];
  generatedAt: string;
}
