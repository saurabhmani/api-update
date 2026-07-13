// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Intelligence Orchestrator
//  Consumes Product A signals — does not modify signal generation.
// ════════════════════════════════════════════════════════════════

import type { ConsumableSignal, PortfolioRecommendation } from '../types';
import type { AllocationMethod } from '../types';
import { buildPortfolioSnapshot } from '../engine/portfolioEngine';
import { getPortfolio } from '../registry/portfolioRegistry';
import { constructPortfolioAllocation } from '../construction/portfolioConstruction';
import { computePortfolioRiskMetrics } from '../risk/riskEngine';
import { prioritizeSignals } from '../prioritization/signalPrioritization';
import { planExecution } from '../planner/executionPlanner';
import { runStressScenarios } from '../scenarios/scenarioAnalysis';
import { buildPortfolioAnalytics } from '../analytics/portfolioAnalytics';
import { explainRecommendations } from '../explainability/portfolioExplainability';
import { exportPortfolioReportBundle } from '../reports/portfolioReporting';
import { versionRecommendation, auditRecommendation } from '../governance/portfolioGovernance';

export interface RunPortfolioIntelligenceInput {
  portfolioId: string;
  signals: ConsumableSignal[];
  author: string;
  allocationMethod?: AllocationMethod;
  replaySeed?: number;
  gitCommit?: string | null;
}

export function runPortfolioIntelligence(input: RunPortfolioIntelligenceInput) {
  const portfolio = getPortfolio(input.portfolioId);
  if (!portfolio) throw new Error(`Portfolio not found: ${input.portfolioId}`);

  const snapshot = buildPortfolioSnapshot(portfolio);
  const allocation = constructPortfolioAllocation(
    input.allocationMethod ?? 'sector_balancing',
    input.signals,
  );
  const risk = computePortfolioRiskMetrics({ snapshot });
  const prioritized = prioritizeSignals(input.signals, snapshot);
  const executionPlan = planExecution(input.portfolioId, prioritized);
  const stress = runStressScenarios(snapshot);
  const analytics = buildPortfolioAnalytics({ snapshot, risk });
  const explanations = explainRecommendations(prioritized, snapshot, risk, allocation);

  const meta = versionRecommendation(
    input.portfolioId,
    input.author,
    input.replaySeed ?? 42,
    input.gitCommit,
  );

  const recommendation: PortfolioRecommendation = {
    ...meta,
    signals: prioritized,
    executionPlan,
    explanations,
  };

  const audit = auditRecommendation(recommendation, input.author);

  const report = exportPortfolioReportBundle({
    portfolio,
    snapshot,
    risk,
    allocation,
    execution: executionPlan,
    stress,
    analytics,
    recommendation,
    explanations,
  });

  return {
    recommendation,
    audit,
    allocation,
    risk,
    stress,
    analytics,
    report,
  };
}
