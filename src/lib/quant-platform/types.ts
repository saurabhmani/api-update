// Quant Intelligence Platform — shared types

export interface ResearchSection {
  title: string;
  content: string;
  confidence?: number;
  /** Underlying data sources referenced in this section */
  dataSources?: string[];
  /** Risk warnings surfaced to the user */
  riskWarnings?: string[];
}

export interface ResearchReport {
  id?: number;
  reportType: 'signal' | 'market' | 'backtest' | 'full';
  title: string;
  generatedAt: string;
  sections: ResearchSection[];
  symbols: string[];
  disclaimers: string[];
  riskWarnings?: string[];
}

export interface StrategyRecommendation {
  rank: number;
  strategyId: string;
  strategyName: string;
  action: 'PROMOTE' | 'ACTIVE' | 'REDUCE' | 'WATCHLIST_ONLY' | 'BLOCK';
  confidence: number;
  regime: string;
  reason: string;
  explainability: string[];
}

export interface PortfolioAllocation {
  symbol: string;
  sector?: string;
  currentWeight: number;
  targetWeight: number;
  delta: number;
}

export interface OptimizationResult {
  allocations: PortfolioAllocation[];
  metrics: {
    portfolioVolatility: number;
    avgCorrelation: number;
    sectorExposure: Record<string, number>;
    riskScore: number;
    /** Herfindahl-Hirschman Index (0–1, lower = more diversified) */
    herfindahlIndex: number;
    /** Effective number of positions (1/HHI) */
    effectivePositions: number;
    diversificationScore: number;
    maxPositionWeight: number;
    maxSectorWeight: number;
  };
  constraints: string[];
  explainability: string[];
}

export interface SectorRotationSnapshot {
  phase: 'risk_on' | 'risk_off' | 'rotation' | 'neutral';
  leaders: Array<{ sector: string; relativeStrength: number; momentum: number }>;
  laggards: Array<{ sector: string; relativeStrength: number; momentum: number }>;
  conviction: number;
  narrative: string;
}

export interface SentimentSummary {
  symbol?: string;
  overallSentiment: number;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  topEvents: Array<{ headline: string; sentiment: number; category: string }>;
  manipulationRisk: number;
}

export interface EventRiskSummary {
  symbol: string;
  overallRisk: number;
  eventCategory: string;
  suppressTrade: boolean;
  reasons: string[];
  manipulationScore: number;
  newsEventRisk: number;
}

export interface EnterpriseReport {
  id?: number;
  reportType: string;
  title: string;
  status: string;
  sections: ResearchSection[];
  generatedAt: string;
}

export interface ApiClientInfo {
  id: number;
  name: string;
  plan: string;
  scopes: string[];
}
