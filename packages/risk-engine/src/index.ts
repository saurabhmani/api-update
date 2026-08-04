/** Stable in-process Risk boundary. Independent hard gates stay distinct. */
export { computePhase3Risk as evaluateSignalRisk } from '@/lib/signal-engine/risk/phase3Risk';
export { evaluatePortfolioFit } from '@/lib/signal-engine/portfolio-fit/evaluatePortfolioFit';
export {
  evaluateExecutionReadiness as evaluatePreTrade,
  resetApprovalGateAggregator,
  flushApprovalGateAggregator,
  getApprovalFunnelSnapshot,
} from '@/lib/signal-engine/execution/executionReadiness';
export { runStressTest as runStressEvaluation } from '@/lib/signal-engine/risk/stressTestEngine';
export {
  calculateSectorExposure,
  calculateStockExposure,
  calculateGrossExposure as calculateExposure,
  calculateCorrelationRisk,
  calculateDirectionImbalance,
  calculateTotalPortfolioRisk,
  evaluatePortfolioRisk,
} from '@/lib/signal-engine/portfolio-fit/portfolioRiskEngine';
export {
  computeExposureBreakdown,
  computeConcentrationHhi as calculateConcentration,
  computeMaxDrawdown,
  computePortfolioRiskMetrics as getRiskSummary,
} from '@/lib/portfolio/risk/riskEngine';

export const RISK_ENGINE_VERSION = {
  contractVersion: '1.0.0',
  implementation: 'quantorus365-monolith',
  failurePolicy: 'preserve-legacy-fail-closed-gates',
} as const;

export type * from '@contracts/risk-engine';
export type * from '@/lib/signal-engine/types/phase3.types';
export type * from '@/lib/signal-engine/risk/stressTestEngine';
export type * from '@/lib/signal-engine/portfolio-fit/portfolioRiskEngine';
