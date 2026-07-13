// ════════════════════════════════════════════════════════════════
//  Strategy Hub — Portfolio & Capital Allocation service (Phase 8)
// ════════════════════════════════════════════════════════════════

import {
  buildPerformanceReport,
  type PerformanceOutcomeRow,
} from '@/lib/strategies/strategyPerformance';
import { loadOutcomesForWindow } from '../services/strategyAnalyticsService';
import { loadStrategyAiInsights } from '../services/strategyAiService';
import { loadLatestValidation } from '../repository/validationHistory';
import { loadAllStrategyProfiles } from '../repository/strategyProfiles';
import { getRegistryEntry, listRegistryStrategyIds } from '../registry';
import { normalizeDeploymentLifecycle, isDeployedLifecycle } from '../deploymentLifecycle';
import { loadInstrumentMeta } from '../analytics/instrumentEnrichment';
import {
  loadPortfolioSettings,
  savePortfolioSettings,
  loadAllAllocations,
  upsertAllocation,
  listAllocationHistory,
} from '../repository/portfolioAllocations';
import {
  listPortfolioAlerts,
  updatePortfolioAlertStatus,
} from '../repository/portfolioAlerts';
import { recordOpsEvent } from '../repository/opsEvents';
import {
  buildAllocationRows,
  computeAllocationsByMethod,
  normalizePctFromAmount,
  validateAllocations,
  type AllocationProposal,
} from '../portfolio/allocationEngine';
import { buildDiversificationAnalysis } from '../portfolio/diversificationAnalyzer';
import { buildPortfolioKPIs } from '../portfolio/portfolioMetrics';
import { buildPortfolioRiskDashboard } from '../portfolio/portfolioRiskEngine';
import { optimizePortfolioAllocation } from '../portfolio/portfolioOptimizer';
import { simulatePortfolioChanges } from '../portfolio/portfolioSimulator';
import { generatePortfolioAlerts } from '../portfolio/portfolioAlertEngine';
import { clearPortfolioCache, getPortfolioCache, portfolioCacheKey, setPortfolioCache } from '../portfolio/portfolioCache';
import { parsePortfolioWindow, portfolioWindowToAnalytics } from '../portfolio/portfolioMath';
import type {
  AllocationMethod,
  AllocationHistoryRow,
  DiversificationAnalysis,
  OptimizationGoal,
  PortfolioAlert,
  PortfolioOptimizationResult,
  PortfolioRiskDashboard,
  PortfolioSettings,
  PortfolioSimulationParams,
  PortfolioSimulationResult,
  PortfolioSummary,
  PortfolioWindow,
  StrategyAllocationRow,
  StrategyPortfolioContext,
} from '../portfolio/types';

export { parsePortfolioWindow };

async function buildStrategyContexts(
  window: PortfolioWindow,
  allocations: Map<string, { allocatedAmount: number; allocatedPct: number; allocationMethod: AllocationMethod; isActive: boolean }>,
): Promise<{
  contexts: StrategyPortfolioContext[];
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>;
}> {
  const analyticsWindow = portfolioWindowToAnalytics(window);
  const { outcomes } = await loadOutcomesForWindow(analyticsWindow);
  const profiles = await loadAllStrategyProfiles();
  const ids = listRegistryStrategyIds();

  const outcomesByStrategy = new Map<string, PerformanceOutcomeRow[]>();
  for (const row of outcomes) {
    const list = outcomesByStrategy.get(row.strategyId) ?? [];
    list.push(row);
    outcomesByStrategy.set(row.strategyId, list);
  }

  const { report } = buildPerformanceReport(outcomes, analyticsWindow === 'TODAY' ? '7D' : analyticsWindow);
  const perfMap = new Map(report.strategies.map((s) => [s.strategyId, s]));

  const contexts: StrategyPortfolioContext[] = [];

  for (const id of ids) {
    const entry = getRegistryEntry(id);
    if (!entry) continue;
    const profile = profiles.get(id);
    const lifecycle = normalizeDeploymentLifecycle(profile?.deployment_status);
    const alloc = allocations.get(id);
    const perf = perfMap.get(id);
    const rows = outcomesByStrategy.get(id) ?? [];

    let aiRiskScore = 30;
    let validationScore: number | null = null;
    try {
      const [ai, validation] = await Promise.all([
        loadStrategyAiInsights({ strategyId: id, window: analyticsWindow, persistRecommendations: false }),
        loadLatestValidation(id),
      ]);
      aiRiskScore = ai.risk.riskScore;
      validationScore = validation?.validation_score ?? null;
    } catch { /* non-fatal */ }

    const environment: StrategyPortfolioContext['environment'] =
      lifecycle === 'live' ? 'live' : lifecycle === 'paper_deployed' ? 'paper' : 'none';

    contexts.push({
      strategyId: id,
      strategyName: entry.displayName,
      deploymentStatus: lifecycle,
      environment,
      allocatedAmount: alloc?.allocatedAmount ?? 0,
      allocatedPct: alloc?.allocatedPct ?? 0,
      winRate: perf?.winRate ?? 0,
      profitFactor: perf?.profitFactor ?? 0,
      maxDrawdownPct: perf?.maxDrawdownPct ?? 0,
      sharpeRatio: null,
      averageConfidence: rows.length
        ? rows.filter((r) => r.confidenceScore != null).reduce((a, r) => a + (r.confidenceScore ?? 0), 0)
          / Math.max(rows.filter((r) => r.confidenceScore != null).length, 1)
        : null,
      healthScore: perf?.strategyHealthScore ?? 0,
      aiRiskScore,
      validationScore,
      evaluatedTrades: perf?.evaluatedSignals ?? 0,
      category: entry.category,
      riskProfile: entry.riskProfile ?? 'moderate',
    });
  }

  return { contexts, outcomesByStrategy };
}

export async function loadPortfolioSummary(
  window: PortfolioWindow = '90D',
  skipCache = false,
): Promise<PortfolioSummary> {
  const cacheKey = portfolioCacheKey({ ns: 'summary', window });
  if (!skipCache) {
    const cached = getPortfolioCache<PortfolioSummary>(cacheKey);
    if (cached) return { ...cached.value, cached: true };
  }

  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts, outcomesByStrategy } = await buildStrategyContexts(window, stored);
  const allocatedCapital = contexts.reduce((a, c) => a + c.allocatedAmount, 0);

  const suggested = computeAllocationsByMethod('performance_weighted', contexts, settings.totalCapital);
  const suggestedMap = new Map(suggested.map((s) => [s.strategyId, s]));

  const allocations = buildAllocationRows(contexts, stored, settings.totalCapital, suggestedMap);
  const kpis = buildPortfolioKPIs(contexts, outcomesByStrategy, settings.totalCapital, allocatedCapital, window);

  const summary: PortfolioSummary = {
    generatedAt: new Date().toISOString(),
    window,
    settings,
    kpis,
    allocations,
    cached: false,
  };

  setPortfolioCache(cacheKey, summary);
  return summary;
}

export async function loadPortfolioRisk(
  window: PortfolioWindow = '90D',
  skipCache = false,
): Promise<PortfolioRiskDashboard> {
  const cacheKey = portfolioCacheKey({ ns: 'risk', window });
  if (!skipCache) {
    const cached = getPortfolioCache<PortfolioRiskDashboard>(cacheKey);
    if (cached) return cached.value;
  }

  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts, outcomesByStrategy } = await buildStrategyContexts(window, stored);
  const risk = buildPortfolioRiskDashboard(contexts, outcomesByStrategy, settings.totalCapital);
  setPortfolioCache(cacheKey, risk);
  return risk;
}

export async function loadDiversificationAnalysis(
  window: PortfolioWindow = '90D',
  skipCache = false,
): Promise<DiversificationAnalysis> {
  const cacheKey = portfolioCacheKey({ ns: 'diversification', window });
  if (!skipCache) {
    const cached = getPortfolioCache<DiversificationAnalysis>(cacheKey);
    if (cached) return cached.value;
  }

  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts, outcomesByStrategy } = await buildStrategyContexts(window, stored);
  const symbols = Array.from(outcomesByStrategy.values()).flat().map((r) => r.symbol);
  const instrumentMeta = await loadInstrumentMeta(symbols);
  const analysis = buildDiversificationAnalysis(contexts, outcomesByStrategy, instrumentMeta, settings.totalCapital);
  setPortfolioCache(cacheKey, analysis);
  return analysis;
}

export async function runPortfolioOptimization(
  goal: OptimizationGoal = 'balanced',
): Promise<PortfolioOptimizationResult> {
  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts } = await buildStrategyContexts('90D', stored);
  const rows = buildAllocationRows(contexts, stored, settings.totalCapital);
  return optimizePortfolioAllocation(goal, contexts, rows, settings.totalCapital);
}

export async function runPortfolioSimulation(
  params: PortfolioSimulationParams,
  window: PortfolioWindow = '90D',
): Promise<PortfolioSimulationResult> {
  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts, outcomesByStrategy } = await buildStrategyContexts(window, stored);
  return simulatePortfolioChanges(window, contexts, outcomesByStrategy, params, settings.totalCapital);
}

export async function refreshPortfolioAlerts(window: PortfolioWindow = '90D'): Promise<number> {
  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts, outcomesByStrategy } = await buildStrategyContexts(window, stored);
  const allocatedCapital = contexts.reduce((a, c) => a + c.allocatedAmount, 0);
  const risk = buildPortfolioRiskDashboard(contexts, outcomesByStrategy, settings.totalCapital);
  const rows = buildAllocationRows(contexts, stored, settings.totalCapital);
  return generatePortfolioAlerts(risk, rows, settings.totalCapital, allocatedCapital);
}

export async function loadPortfolioAlerts(opts: {
  status?: 'open' | 'acknowledged' | 'resolved' | 'all';
  limit?: number;
}): Promise<PortfolioAlert[]> {
  return listPortfolioAlerts(opts);
}

export async function acknowledgePortfolioAlert(id: number, actor: string): Promise<boolean> {
  return updatePortfolioAlertStatus(id, 'acknowledged', actor);
}

export async function resolvePortfolioAlert(id: number, actor: string): Promise<boolean> {
  return updatePortfolioAlertStatus(id, 'resolved', actor);
}

export async function loadAllocationHistory(opts: {
  strategyId?: string;
  limit?: number;
}): Promise<AllocationHistoryRow[]> {
  const rows = await listAllocationHistory(opts);
  return rows.map((r) => {
    const entry = getRegistryEntry(r.strategyId);
    return { ...r, strategyName: entry?.displayName ?? r.strategyName };
  });
}

export interface SaveAllocationsInput {
  method: AllocationMethod;
  allocations: Array<{ strategyId: string; amount?: number; pct?: number }>;
  actor: string;
  reason?: string;
}

export async function saveCapitalAllocations(
  input: SaveAllocationsInput,
): Promise<{ ok: boolean; errors: string[]; allocations: StrategyAllocationRow[] }> {
  const settings = await loadPortfolioSettings();
  const stored = await loadAllAllocations();
  const { contexts } = await buildStrategyContexts('90D', stored);

  const manual: Record<string, { amount?: number; pct?: number }> = {};
  for (const a of input.allocations) {
    manual[a.strategyId] = { amount: a.amount, pct: a.pct };
  }

  let proposals: AllocationProposal[];
  if (input.method === 'manual' || input.method === 'fixed' || input.method === 'percentage') {
    proposals = input.allocations.map((a) => {
      const amount = a.amount ?? 0;
      const pct = a.pct ?? normalizePctFromAmount(amount, settings.totalCapital);
      return { strategyId: a.strategyId, amount, pct };
    });
  } else {
    proposals = computeAllocationsByMethod(input.method, contexts, settings.totalCapital, manual);
  }

  const validation = validateAllocations(proposals, settings.totalCapital);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, allocations: [] };
  }

  for (const p of proposals) {
    const ctx = contexts.find((c) => c.strategyId === p.strategyId);
    if (!ctx) continue;
    if (!isDeployedLifecycle(normalizeDeploymentLifecycle(ctx.deploymentStatus)) && p.amount > 0) {
      return {
        ok: false,
        errors: [`${p.strategyId} is not deployed — cannot allocate capital.`],
        allocations: [],
      };
    }
    const existing = stored.get(p.strategyId);
    await upsertAllocation({
      strategyId: p.strategyId,
      method: input.method,
      amount: p.amount,
      pct: p.pct,
      isActive: p.amount > 0,
      actor: input.actor,
      reason: input.reason,
      fromAmount: existing?.allocatedAmount,
      fromPct: existing?.allocatedPct,
    });
  }

  await recordOpsEvent({
    eventType: 'portfolio-allocation-update',
    title: 'Capital allocations updated',
    description: `Method: ${input.method}, ${proposals.length} strategies.`,
    actor: input.actor,
    details: { method: input.method, proposals },
  });

  clearPortfolioCache();
  const summary = await loadPortfolioSummary('90D', true);
  return { ok: true, errors: [], allocations: summary.allocations };
}

export async function updatePortfolioCapital(
  totalCapital: number,
  actor: string,
): Promise<PortfolioSettings> {
  const result = await savePortfolioSettings({ totalCapital }, actor);
  clearPortfolioCache();
  await recordOpsEvent({
    eventType: 'portfolio-capital-update',
    title: 'Total portfolio capital updated',
    description: `New total: ${totalCapital}`,
    actor,
  });
  return result;
}

export { clearPortfolioCache };
