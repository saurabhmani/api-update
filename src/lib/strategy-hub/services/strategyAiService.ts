// ════════════════════════════════════════════════════════════════
//  Strategy Hub — AI Intelligence service (Phase 7)
//
//  Orchestrates the AI engines over real analytics data. Insights
//  are read-only; applying a recommendation is a separate, audited
//  admin action that never auto-runs from this service.
// ════════════════════════════════════════════════════════════════

import { resolveEffectiveStrategyMode } from '@/lib/signal-engine/strategies/strategyModePolicy';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import { buildAiRecommendations } from '../ai/advisorEngine';
import { detectAnomalies } from '../ai/anomalyDetector';
import { aiCacheKey, clearAiCache, getAiCache, setAiCache } from '../ai/aiCache';
import { buildExecutiveSummary, type StrategyInsightSnapshot } from '../ai/executiveSummaryBuilder';
import { simulateStrategyChanges } from '../ai/optimizationSimulator';
import { buildAiPrediction } from '../ai/predictiveEngine';
import { buildRiskAssessment } from '../ai/riskEngine';
import type {
  AiInsightsBundle,
  AiRecommendation,
  ExecutiveSummary,
  SimulationParams,
  SimulationResult,
  SummaryPeriod,
} from '../ai/types';
import type { AnalyticsWindow } from '../analytics/types';
import { getRegistryEntry, listRegistryStrategyIds } from '../registry';
import {
  listAiRecommendationHistory,
  mapHistoryRowToRecommendation,
  updateAiRecommendationStatus,
  upsertAiRecommendations,
} from '../repository/aiRecommendations';
import { countOpenAlerts } from '../repository/opsAlerts';
import { recordOpsEvent } from '../repository/opsEvents';
import { loadStrategyProfile } from '../repository/strategyProfiles';
import { loadLatestValidation } from '../repository/validationHistory';
import { loadOutcomesForWindow, loadStrategyAnalytics } from './strategyAnalyticsService';
import { extractModeOverride } from './strategyModeOverrides';
import { setStrategyMode } from './modeManagementService';

function windowForPeriod(period: SummaryPeriod): AnalyticsWindow {
  if (period === 'daily') return '7D';
  if (period === 'weekly') return '30D';
  return '90D';
}

function dataStatus(evaluated: number): AiInsightsBundle['dataStatus'] {
  if (evaluated >= 15) return 'SUFFICIENT';
  if (evaluated >= 5) return 'LIMITED';
  return 'INSUFFICIENT';
}

async function loadStrategyContext(strategyId: string) {
  const [profile, latestValidation] = await Promise.all([
    loadStrategyProfile(strategyId),
    loadLatestValidation(strategyId),
  ]);
  const entry = getRegistryEntry(strategyId);
  const override = extractModeOverride(profile?.metadata_json);
  const currentMode = resolveEffectiveStrategyMode(strategyId, undefined, override);
  return {
    profile,
    entry,
    currentMode,
    deploymentStatus: profile?.deployment_status ?? 'draft',
    paperTradingEnabled: Boolean(profile?.paper_trading_enabled),
    allowedRegimes: entry?.allowedRegimes ?? null,
    riskProfile: entry?.riskProfile ?? profile?.risk_profile ?? null,
    latestValidation: latestValidation
      ? {
          status: latestValidation.overall_status,
          score: latestValidation.validation_score,
          target: latestValidation.validation_target,
          at: latestValidation.created_at,
        }
      : null,
  };
}

export interface LoadAiInsightsOptions {
  strategyId: string;
  window?: AnalyticsWindow;
  skipCache?: boolean;
  persistRecommendations?: boolean;
}

export async function loadStrategyAiInsights(
  opts: LoadAiInsightsOptions,
): Promise<AiInsightsBundle> {
  const window = opts.window ?? '90D';
  const cacheKey = aiCacheKey({ ns: 'ai-insights', strategyId: opts.strategyId, window });

  if (!opts.skipCache) {
    const cached = getAiCache<AiInsightsBundle>(cacheKey);
    if (cached) return { ...cached.value, cached: true };
  }

  const ctx = await loadStrategyContext(opts.strategyId);
  const analytics = await loadStrategyAnalytics({
    strategyId: opts.strategyId,
    window,
    sections: ['summary', 'regime', 'confidence', 'trends', 'learning'],
  });

  const { outcomes } = await loadOutcomesForWindow(window);
  const rows = outcomes.filter((o) => o.strategyId === opts.strategyId);
  const backtestShare = rows.length
    ? rows.filter((r) => r.source === 'backtest').length / rows.length
    : 0;

  const prediction = buildAiPrediction(
    opts.strategyId,
    analytics.trends,
    analytics.summary,
    window,
  );
  const risk = buildRiskAssessment({
    strategyId: opts.strategyId,
    summary: analytics.summary,
    prediction,
    regime: analytics.regime,
    confidence: analytics.confidence,
    allowedRegimes: ctx.allowedRegimes,
    window,
    backtestShare,
  });
  const anomalies = detectAnomalies(opts.strategyId, rows, {
    window,
    pipelineSignals: analytics.sourceStatus.pipelineSignals,
  });
  const recommendations = buildAiRecommendations({
    strategyId: opts.strategyId,
    strategyName: analytics.summary?.strategyName ?? ctx.entry?.displayName ?? opts.strategyId,
    window,
    rows,
    summary: analytics.summary,
    regime: analytics.regime,
    confidence: analytics.confidence,
    learning: analytics.learning,
    prediction,
    risk,
    anomalies,
    currentMode: ctx.currentMode,
    deploymentStatus: ctx.deploymentStatus,
    paperTradingEnabled: ctx.paperTradingEnabled,
    latestValidation: ctx.latestValidation,
    allowedRegimes: ctx.allowedRegimes,
    riskProfile: ctx.riskProfile,
  });

  if (opts.persistRecommendations !== false) {
    await upsertAiRecommendations(opts.strategyId, recommendations);
  }

  const bundle: AiInsightsBundle = {
    generatedAt: new Date().toISOString(),
    strategyId: opts.strategyId,
    window,
    recommendations,
    prediction,
    risk,
    anomalies,
    dataStatus: dataStatus(analytics.summary?.evaluatedSignals ?? 0),
    cached: false,
  };

  setAiCache(cacheKey, bundle);
  return bundle;
}

export async function loadHubAiRecommendations(opts: {
  window?: AnalyticsWindow;
  limit?: number;
  skipCache?: boolean;
}): Promise<{
  generatedAt: string;
  window: AnalyticsWindow;
  recommendations: AiRecommendation[];
  cached: boolean;
}> {
  const window = opts.window ?? '90D';
  const cacheKey = aiCacheKey({ ns: 'hub-ai-recs', window, limit: opts.limit ?? 50 });

  if (!opts.skipCache) {
    const cached = getAiCache<{ generatedAt: string; window: AnalyticsWindow; recommendations: AiRecommendation[] }>(cacheKey);
    if (cached) return { ...cached.value, cached: true };
  }

  const ids = listRegistryStrategyIds();
  const all: AiRecommendation[] = [];
  for (const id of ids) {
    const insights = await loadStrategyAiInsights({ strategyId: id, window, skipCache: opts.skipCache });
    all.push(...insights.recommendations);
  }
  all.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.confidenceLevel] - order[b.confidenceLevel];
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    window,
    recommendations: all.slice(0, opts.limit ?? 50),
  };
  setAiCache(cacheKey, payload);
  return { ...payload, cached: false };
}

export async function loadExecutiveAiSummary(
  period: SummaryPeriod = 'weekly',
  skipCache = false,
): Promise<ExecutiveSummary> {
  const window = windowForPeriod(period);
  const cacheKey = aiCacheKey({ ns: 'executive-summary', period, window });

  if (!skipCache) {
    const cached = getAiCache<ExecutiveSummary>(cacheKey);
    if (cached) return cached.value;
  }

  const ids = listRegistryStrategyIds();
  const openAlerts = await countOpenAlerts().catch(() => 0);
  const snapshots: StrategyInsightSnapshot[] = [];

  for (const id of ids) {
    const insights = await loadStrategyAiInsights({ strategyId: id, window, skipCache });
    const ctx = await loadStrategyContext(id);
    const analytics = await loadStrategyAnalytics({
      strategyId: id,
      window,
      sections: ['summary'],
    });
    snapshots.push({
      strategyId: id,
      strategyName: analytics.summary?.strategyName ?? ctx.entry?.displayName ?? id,
      winRate: analytics.summary?.winRate ?? 0,
      profitFactor: analytics.summary?.profitFactor ?? 0,
      maxDrawdownPct: analytics.summary?.maxDrawdownPct ?? 0,
      evaluatedSignals: analytics.summary?.evaluatedSignals ?? 0,
      healthLabel: analytics.summary?.healthLabel ?? 'INSUFFICIENT_DATA',
      prediction: insights.prediction,
      risk: insights.risk,
      recommendations: insights.recommendations,
      anomalies: insights.anomalies,
      validationStatus: ctx.latestValidation?.status ?? null,
    });
  }

  const summary = buildExecutiveSummary(snapshots, { period, window, openAlerts });
  setAiCache(cacheKey, summary, period === 'monthly' ? 30 * 60 * 1000 : 10 * 60 * 1000);
  return summary;
}

export async function runOptimizationSimulation(
  strategyId: string,
  params: SimulationParams,
  window: AnalyticsWindow = '90D',
): Promise<SimulationResult> {
  const { outcomes } = await loadOutcomesForWindow(window);
  const rows = outcomes.filter((o) => o.strategyId === strategyId);
  return simulateStrategyChanges(strategyId, rows, params, window);
}

export async function loadAiRecommendationHistory(opts: {
  strategyId?: string;
  limit?: number;
}) {
  const rows = await listAiRecommendationHistory({
    strategyId: opts.strategyId,
    limit: opts.limit ?? 50,
  });
  return rows.map((row) => {
    const entry = getRegistryEntry(row.strategy_id);
    return {
      ...row,
      recommendation: mapHistoryRowToRecommendation(
        row,
        entry?.displayName ?? row.strategy_id,
      ),
    };
  });
}

export interface ApplyRecommendationResult {
  ok: boolean;
  message: string;
  applied?: boolean;
  modeChange?: {
    fromMode: StrategyMode;
    toMode: StrategyMode;
    changed: boolean;
  };
}

/**
 * Apply an AI recommendation — admin only, always audited.
 * Only mode-change recommendations are executable here; config and
 * deployment recommendations return guidance for manual action.
 */
export async function applyAiRecommendation(opts: {
  strategyId: string;
  recKey: string;
  userId: number;
  actor: string;
}): Promise<ApplyRecommendationResult> {
  const history = await listAiRecommendationHistory({
    strategyId: opts.strategyId,
    limit: 100,
  });
  const row = history.find((r) => r.rec_key === opts.recKey);
  if (!row) {
    return { ok: false, message: 'Recommendation not found in history.' };
  }
  if (row.status === 'applied') {
    return { ok: false, message: 'Recommendation was already applied.' };
  }

  const rec = mapHistoryRowToRecommendation(
    row,
    getRegistryEntry(opts.strategyId)?.displayName ?? opts.strategyId,
  );

  if (rec.applyMode === 'mode_change' && rec.targetMode) {
    const mode = rec.targetMode as StrategyMode;
    const result = await setStrategyMode({
      strategyId: opts.strategyId,
      mode,
      userId: opts.userId,
      actor: opts.actor,
      reason: `AI recommendation applied: ${rec.action}`,
      source: 'system',
    });
    if (!result.ok) {
      return { ok: false, message: result.error ?? 'Mode change failed.' };
    }
    await updateAiRecommendationStatus({
      strategyId: opts.strategyId,
      recKey: opts.recKey,
      status: 'applied',
      appliedBy: opts.actor,
    });
    await recordOpsEvent({
      eventType: 'ai-recommendation-applied',
      strategyId: opts.strategyId,
      severity: 'info',
      title: `AI recommendation applied: ${rec.action}`,
      description: rec.reason,
      actor: opts.actor,
      details: { recKey: opts.recKey, targetMode: rec.targetMode, evidence: rec.evidence },
    });
    clearAiCache();
    return {
      ok: true,
      applied: true,
      message: result.changed
        ? `Mode changed from ${result.fromMode} to ${result.toMode}.`
        : `Strategy was already in ${result.toMode} mode.`,
      modeChange: {
        fromMode: result.fromMode,
        toMode: result.toMode,
        changed: result.changed,
      },
    };
  }

  if (rec.applyMode === 'manual_config') {
    await updateAiRecommendationStatus({
      strategyId: opts.strategyId,
      recKey: opts.recKey,
      status: 'dismissed',
      appliedBy: opts.actor,
    });
    await recordOpsEvent({
      eventType: 'ai-recommendation-acknowledged',
      strategyId: opts.strategyId,
      title: `AI config recommendation acknowledged: ${rec.action}`,
      description: 'Administrator acknowledged — apply manually via Configuration tab.',
      actor: opts.actor,
      details: { recKey: opts.recKey, evidence: rec.evidence },
    });
    return {
      ok: true,
      applied: false,
      message: 'Configuration recommendations must be applied manually via the Configuration tab. Recommendation acknowledged and logged.',
    };
  }

  if (rec.applyMode === 'manual_deploy') {
    await recordOpsEvent({
      eventType: 'ai-recommendation-acknowledged',
      strategyId: opts.strategyId,
      title: `AI deployment recommendation acknowledged: ${rec.action}`,
      description: 'Use the Deploy workflow after validation passes.',
      actor: opts.actor,
      details: { recKey: opts.recKey, evidence: rec.evidence },
    });
    return {
      ok: true,
      applied: false,
      message: 'Deployment recommendations require explicit validation and deploy workflow — not auto-applied.',
    };
  }

  await updateAiRecommendationStatus({
    strategyId: opts.strategyId,
    recKey: opts.recKey,
    status: 'dismissed',
    appliedBy: opts.actor,
  });
  return { ok: true, applied: false, message: 'Advisory recommendation dismissed and logged.' };
}

/** Scheduled AI analysis — refreshes insights without changing configuration. */
export async function runScheduledAiAnalysis(
  job: 'daily_review' | 'weekly_optimization' | 'monthly_executive' | 'anomaly_detection' | 'recommendation_refresh',
  actor = 'scheduler',
): Promise<{ ok: boolean; message: string }> {
  try {
    switch (job) {
      case 'daily_review': {
        const ids = listRegistryStrategyIds();
        for (const id of ids) {
          await loadStrategyAiInsights({ strategyId: id, window: '7D', skipCache: true });
        }
        await recordOpsEvent({
          eventType: 'ai-daily-review',
          title: 'Daily AI strategy review completed',
          description: `Analyzed ${ids.length} strategies.`,
          actor,
        });
        break;
      }
      case 'weekly_optimization': {
        await loadHubAiRecommendations({ window: '30D', skipCache: true });
        await recordOpsEvent({
          eventType: 'ai-weekly-optimization',
          title: 'Weekly optimization report generated',
          actor,
        });
        break;
      }
      case 'monthly_executive': {
        await loadExecutiveAiSummary('monthly', true);
        await recordOpsEvent({
          eventType: 'ai-monthly-executive',
          title: 'Monthly executive AI summary generated',
          actor,
        });
        break;
      }
      case 'anomaly_detection': {
        const ids = listRegistryStrategyIds();
        let anomalyCount = 0;
        for (const id of ids) {
          const insights = await loadStrategyAiInsights({ strategyId: id, window: '30D', skipCache: true });
          anomalyCount += insights.anomalies.length;
        }
        await recordOpsEvent({
          eventType: 'ai-anomaly-detection',
          title: 'Automatic anomaly detection completed',
          description: `${anomalyCount} anomalies detected.`,
          actor,
        });
        break;
      }
      case 'recommendation_refresh': {
        clearAiCache();
        await loadHubAiRecommendations({ skipCache: true });
        await recordOpsEvent({
          eventType: 'ai-recommendation-refresh',
          title: 'AI recommendations refreshed',
          actor,
        });
        break;
      }
      default:
        return { ok: false, message: 'Unknown AI job.' };
    }
    return { ok: true, message: `${job} completed.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'AI job failed.' };
  }
}

export { clearAiCache };
