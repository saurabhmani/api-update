// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Intelligence Platform
//  Consumes Product A signals — does not modify signal generation.
// ════════════════════════════════════════════════════════════════

export * from './types';
export * from './consumption/signalAdapter';
export * from './registry/portfolioRegistry';
export * from './engine/portfolioEngine';
export * from './construction/portfolioConstruction';
export * from './risk/riskEngine';
export * from './prioritization/signalPrioritization';
export * from './planner/executionPlanner';
export * from './scenarios/scenarioAnalysis';
export * from './analytics/portfolioAnalytics';
export * from './explainability/portfolioExplainability';
export * from './reports/portfolioReporting';
export * from './governance/portfolioGovernance';
export * from './intelligence/runPortfolioIntelligence';

export const PORTFOLIO_INTELLIGENCE_VERSION = '8.0.0';
