// ════════════════════════════════════════════════════════════════
//  Strategy Hub — Portfolio & Capital Allocation types (Phase 8)
// ════════════════════════════════════════════════════════════════

export type PortfolioWindow = 'TODAY' | '7D' | '30D' | '90D' | '1Y' | 'ALL';

export const PORTFOLIO_WINDOWS: readonly PortfolioWindow[] = [
  'TODAY', '7D', '30D', '90D', '1Y', 'ALL',
] as const;

export type AllocationMethod =
  | 'fixed'
  | 'percentage'
  | 'equal'
  | 'risk_weighted'
  | 'performance_weighted'
  | 'confidence_weighted'
  | 'manual';

export type OptimizationGoal =
  | 'maximize_return'
  | 'minimize_risk'
  | 'balanced'
  | 'income'
  | 'growth'
  | 'conservative';

export type PortfolioAlertType =
  | 'over_allocation'
  | 'excessive_exposure'
  | 'high_correlation'
  | 'capital_exhaustion'
  | 'risk_threshold'
  | 'portfolio_drawdown'
  | 'allocation_imbalance';

export type PortfolioAlertSeverity = 'info' | 'warning' | 'critical';
export type PortfolioAlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface PortfolioSettings {
  totalCapital: number;
  currency: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface StrategyAllocationRow {
  strategyId: string;
  strategyName: string;
  deploymentStatus: string;
  environment: 'paper' | 'live' | 'none';
  allocationMethod: AllocationMethod;
  allocatedAmount: number;
  allocatedPct: number;
  suggestedAmount: number | null;
  suggestedPct: number | null;
  isActive: boolean;
  eligible: boolean;
  ineligibleReason?: string;
}

export interface PortfolioKPIs {
  totalCapital: number;
  allocatedCapital: number;
  availableCapital: number;
  activeStrategies: number;
  liveStrategies: number;
  paperStrategies: number;
  portfolioReturnPct: number;
  portfolioCagrPct: number | null;
  portfolioSharpe: number | null;
  portfolioSortino: number | null;
  portfolioProfitFactor: number;
  portfolioDrawdownPct: number;
  portfolioWinRate: number;
  portfolioRiskScore: number;
  evaluatedTrades: number;
  dataStatus: 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
}

export interface PortfolioSummary {
  generatedAt: string;
  window: PortfolioWindow;
  settings: PortfolioSettings;
  kpis: PortfolioKPIs;
  allocations: StrategyAllocationRow[];
  cached: boolean;
}

export interface AllocationHistoryRow {
  id: number;
  strategyId: string;
  strategyName: string;
  fromAmount: number;
  toAmount: number;
  fromPct: number;
  toPct: number;
  method: AllocationMethod;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

export interface PortfolioRiskFactor {
  id: string;
  label: string;
  severity: PortfolioAlertSeverity;
  value: number | string;
  threshold: number | string;
  detail: string;
}

export interface PortfolioRiskDashboard {
  riskScore: number;
  riskCategory: 'low' | 'moderate' | 'elevated' | 'high';
  portfolioVar95Pct: number | null;
  maxDrawdownPct: number;
  sectorExposure: Array<{ sector: string; weightPct: number; trades: number }>;
  strategyConcentration: Array<{ strategyId: string; strategyName: string; weightPct: number }>;
  correlationRisk: {
    averageCorrelation: number | null;
    highCorrelationPairs: Array<{ a: string; b: string; correlation: number }>;
  };
  liquidityRisk: 'low' | 'medium' | 'high';
  regimeExposure: Array<{ regime: string; weightPct: number }>;
  diversificationScore: number;
  factors: PortfolioRiskFactor[];
  warnings: string[];
}

export interface DiversificationBucket {
  key: string;
  label: string;
  weightPct: number;
  tradeCount: number;
  strategyCount: number;
}

export interface DiversificationAnalysis {
  diversificationScore: number;
  herfindahlIndex: number;
  strategyType: DiversificationBucket[];
  sector: DiversificationBucket[];
  industry: DiversificationBucket[];
  marketCap: DiversificationBucket[];
  exchange: DiversificationBucket[];
  regime: DiversificationBucket[];
  riskProfile: DiversificationBucket[];
  recommendations: string[];
}

export interface OptimizationRecommendation {
  strategyId: string;
  strategyName: string;
  currentPct: number;
  recommendedPct: number;
  deltaPct: number;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface PortfolioOptimizationResult {
  goal: OptimizationGoal;
  currentAllocations: StrategyAllocationRow[];
  recommendedAllocations: OptimizationRecommendation[];
  expectedReturnImprovementPct: number | null;
  expectedRiskImpact: string;
  expectedDrawdownChangePct: number | null;
  notes: string[];
  advisoryOnly: true;
}

export interface PortfolioSimulationParams {
  totalCapital?: number;
  allocations?: Array<{ strategyId: string; amount?: number; pct?: number }>;
  addStrategies?: string[];
  removeStrategies?: string[];
  regimeFilter?: string | null;
  riskProfileFilter?: string | null;
}

export interface PortfolioSimulationResult {
  window: PortfolioWindow;
  params: PortfolioSimulationParams;
  projected: {
    returnPct: number;
    drawdownPct: number;
    winRate: number;
    sharpe: number | null;
    riskScore: number;
    capitalUtilizationPct: number;
  };
  baseline: {
    returnPct: number;
    drawdownPct: number;
    winRate: number;
    sharpe: number | null;
    riskScore: number;
    capitalUtilizationPct: number;
  };
  delta: {
    returnPct: number;
    drawdownPct: number;
    winRate: number;
    riskScore: number;
  };
  notes: string[];
  productionUnchanged: true;
}

export interface PortfolioAlert {
  id: number;
  alertKey: string;
  type: PortfolioAlertType;
  severity: PortfolioAlertSeverity;
  title: string;
  description: string;
  suggestedAction: string;
  status: PortfolioAlertStatus;
  strategyId: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface StrategyPortfolioContext {
  strategyId: string;
  strategyName: string;
  deploymentStatus: string;
  environment: 'paper' | 'live' | 'none';
  allocatedAmount: number;
  allocatedPct: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number | null;
  averageConfidence: number | null;
  healthScore: number;
  aiRiskScore: number;
  validationScore: number | null;
  evaluatedTrades: number;
  category: string;
  riskProfile: string;
}
