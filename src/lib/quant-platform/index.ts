export type {
  ResearchReport, ResearchSection, StrategyRecommendation,
  OptimizationResult, PortfolioAllocation, SectorRotationSnapshot,
  SentimentSummary, EventRiskSummary, EnterpriseReport, ApiClientInfo,
} from './types';

export {
  generateResearchReport, explainSignal, explainMarketConditions, explainBacktest,
} from './ai-research/researchAssistant';

export { getStrategyRecommendations } from './strategy-recommendations/recommendationEngine';
export { optimizePortfolio } from './portfolio-optimizer/optimizer';
export { computeSectorRotation } from './sector-rotation/sectorRotationEngine';
export { getNewsSentiment } from './news-sentiment/sentimentService';
export { detectEventRisk } from './event-risk/eventRiskAggregator';
export { generateEnterpriseReport, formatReportAsMarkdown } from './enterprise-reports/reportGenerator';
export { createApiKey, validateApiKey, requireApiKey, listApiClients } from './api-platform/apiKeyAuth';
export { listResearchReports } from './repository/quantRepository';
