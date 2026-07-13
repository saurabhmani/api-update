// ════════════════════════════════════════════════════════════════
//  Strategy Hub — AI Intelligence & Decision Support types (Phase 7)
//
//  Every insight in this module is derived from persisted platform
//  data (outcomes, validation history, learning reports, analytics).
//  Nothing is fabricated: each recommendation carries its evidence
//  and the historical basis it was computed from.
// ════════════════════════════════════════════════════════════════

export type AiConfidenceLevel = 'high' | 'medium' | 'low';

export type AiRecommendationCategory =
  | 'threshold'      // confidence / parameter threshold tuning
  | 'parameter'      // RSI / ADX / weight adjustments
  | 'regime'         // restrict or favour market regimes
  | 'risk'           // risk profile / sizing
  | 'mode'           // watchlist / disable / enable
  | 'deployment';    // paper / live deployment advice

export type AiRecommendationStatus = 'active' | 'applied' | 'dismissed' | 'expired';

export interface AiRecommendation {
  /** Stable key — dedupes recommendations across refreshes. */
  key: string;
  strategyId: string;
  strategyName: string;
  category: AiRecommendationCategory;
  action: string;
  reason: string;
  evidence: string[];
  expectedImpact: string;
  confidenceLevel: AiConfidenceLevel;
  /** e.g. "90D window, 42 evaluated trades (direct + observed outcomes)" */
  historicalBasis: string;
  /** How the admin should act on it (mode recs are executable). */
  applyMode: 'mode_change' | 'manual_config' | 'manual_deploy' | 'advisory';
  /** Target mode when applyMode === 'mode_change'. */
  targetMode?: string;
}

export interface AiPrediction {
  strategyId: string;
  trend: 'improving' | 'stable' | 'declining';
  expectedWinRate: number | null;
  expectedDrawdownPct: number | null;
  expectedProfitFactor: number | null;
  expectedSharpe: number | null;
  expectedConfidence: number | null;
  /** Slope of win-rate per trend bucket (percentage points). */
  winRateSlope: number;
  returnSlope: number;
  confidenceSlope: number;
  basis: string;
  dataPoints: number;
  reliable: boolean;
}

export type AiRiskCategory = 'low' | 'moderate' | 'elevated' | 'high';

export interface AiRiskFactor {
  id: string;
  label: string;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  mitigation: string;
}

export interface AiRiskAssessment {
  strategyId: string;
  riskScore: number;          // 0 (safe) – 100 (dangerous)
  riskCategory: AiRiskCategory;
  drawdownProbability: 'low' | 'medium' | 'high';
  deteriorationRisk: 'low' | 'medium' | 'high';
  confidenceDegradation: boolean;
  regimeMismatchRisk: boolean;
  signalQualityRisk: boolean;
  overfittingIndicator: boolean;
  factors: AiRiskFactor[];
  basis: string;
}

export type AiAnomalyType =
  | 'win_rate_drop'
  | 'approval_collapse'
  | 'missing_signals'
  | 'confidence_anomaly'
  | 'inactivity'
  | 'drawdown_spike'
  | 'regime_shift'
  | 'execution_anomaly';

export interface AiAnomaly {
  id: string;
  strategyId: string;
  type: AiAnomalyType;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  rootCause: string;
  suggestedAction: string;
  detectedAt: string;
  metrics: Record<string, number | string | null>;
}

export interface SimulationParams {
  /** Only include outcomes with confidence >= this value. */
  minConfidence?: number | null;
  /** Exclude outcomes recorded in these regimes. */
  excludedRegimes?: string[] | null;
  /** Only include this direction. */
  direction?: 'BUY' | 'SELL' | null;
  /** Only include approved signals. */
  approvedOnly?: boolean | null;
}

export interface SimulationMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  expectancy: number;
  averageConfidence: number | null;
  averageReturnPct: number;
}

export interface SimulationResult {
  strategyId: string;
  window: string;
  params: SimulationParams;
  baseline: SimulationMetrics;
  simulated: SimulationMetrics;
  delta: {
    winRate: number;
    profitFactor: number;
    maxDrawdownPct: number;
    expectancy: number;
    trades: number;
  };
  rankingImpact: 'likely_up' | 'likely_down' | 'neutral' | 'insufficient_data';
  notes: string[];
  /** Simulations never touch production configuration. */
  productionUnchanged: true;
}

export type SummaryPeriod = 'daily' | 'weekly' | 'monthly';

export interface ExecutiveSummary {
  generatedAt: string;
  period: SummaryPeriod;
  window: string;
  headline: string;
  bestPerformers: Array<{ strategyId: string; strategyName: string; note: string }>;
  needsAttention: Array<{ strategyId: string; strategyName: string; note: string }>;
  deploymentRecommendations: string[];
  validationConcerns: string[];
  riskSummary: string[];
  performanceHighlights: string[];
  optimizationOpportunities: string[];
  totals: {
    strategiesAnalyzed: number;
    evaluatedTrades: number;
    openAlerts: number;
    failedValidations: number;
  };
}

export interface AiInsightsBundle {
  generatedAt: string;
  strategyId: string;
  window: string;
  recommendations: AiRecommendation[];
  prediction: AiPrediction;
  risk: AiRiskAssessment;
  anomalies: AiAnomaly[];
  dataStatus: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
  cached: boolean;
}

export interface AiRecommendationHistoryRow {
  id: number;
  strategy_id: string;
  rec_key: string;
  category: string;
  action: string;
  reason: string;
  evidence_json: string[] | null;
  expected_impact: string;
  confidence_level: string;
  apply_mode: string;
  target_mode: string | null;
  status: AiRecommendationStatus;
  applied_by: string | null;
  applied_at: string | null;
  created_at: string;
}
