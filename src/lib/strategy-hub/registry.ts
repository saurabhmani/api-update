// ════════════════════════════════════════════════════════════════
//  Strategy Hub Registry — dynamic loader over signal-engine registry
// ════════════════════════════════════════════════════════════════

import { STRATEGY_REGISTRY } from '@strategy-engine';
import { resolveEffectiveStrategyMode } from '@/lib/signal-engine/strategies/strategyModePolicy';
import type { StrategyCardStatus, StrategyHubSummary, StrategyHubDetail } from './types';
import { categoryLabel, riskProfileLabel } from './categories';
import { assessPaperTradingReadiness } from './services/paperTradingReadiness';
import { resolveDeploymentLifecycle } from './deploymentLifecycle';
import { extractModeOverride } from './services/strategyModeOverrides';
import type { StrategyProfileRow } from './types';
import type { StrategyName, StrategyRegistryEntry } from '@/lib/signal-engine/types/signalEngine.types';

/** Initial featured strategies for the Strategy Hub spotlight. */
export const FEATURED_STRATEGY_IDS: StrategyName[] = [
  'bullish_breakout',
  'momentum_continuation',
  'bullish_pullback',
  'fibonacci_pullback',
  'ema_crossover',
];

/** Strategies with evaluators wired in runStrategies.ts */
export const ACTIVE_RUNNER_STRATEGIES = new Set<StrategyName>([
  'bullish_breakout',
  'momentum_continuation',
  'gap_continuation',
  'bullish_pullback',
  'fibonacci_pullback',
  'bearish_breakdown',
  'overbought_reversal',
  'weak_trend_breakdown',
  'mean_reversion_bounce',
  'bullish_divergence',
  'volume_climax_reversal',
  'range_breakout',
  'ema_crossover',
  'oversold_bounce',
  'failed_breakout_reversal',
  'bearish_pullback_rejection',
  'volatility_squeeze_breakout',
]);

const EVALUATOR_STRATEGIES = ACTIVE_RUNNER_STRATEGIES;

export function listRegistryStrategyIds(): StrategyName[] {
  return Object.keys(STRATEGY_REGISTRY) as StrategyName[];
}

export function getRegistryEntry(strategyId: string): StrategyRegistryEntry | null {
  return STRATEGY_REGISTRY[strategyId as StrategyName] ?? null;
}

export function isFeaturedStrategy(strategyId: string): boolean {
  return FEATURED_STRATEGY_IDS.includes(strategyId as StrategyName);
}

function timeframeLabel(timeframe: string): string {
  const normalized = timeframe.toLowerCase();
  if (normalized === 'swing') return 'Positional';
  if (normalized === 'intraday') return 'Intraday';
  return timeframe.replace(/_/g, ' ');
}

function cardStatus(
  entry: StrategyRegistryEntry,
  paperReady: boolean,
  isActiveInRunner: boolean,
  effectiveMode?: string,
): StrategyCardStatus {
  if ((effectiveMode ?? entry.strategyMode) === 'DISABLED') return 'Inactive';
  if (paperReady || isActiveInRunner) return 'Active';
  return 'Inactive';
}

export function mapEntryToSummary(
  entry: StrategyRegistryEntry,
  profile?: StrategyProfileRow | null,
): StrategyHubSummary {
  const paper = assessPaperTradingReadiness(entry.strategyId, {
    hasEvaluator: EVALUATOR_STRATEGIES.has(entry.strategyId),
    isActiveInRunner: ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId),
    profile,
  });
  const activeInRunner = ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId);
  const paperReady = profile?.paper_trading_enabled ?? paper.ready;
  const modeOverride = extractModeOverride(profile?.metadata_json);
  const deploymentLifecycle = resolveDeploymentLifecycle({
    storedStatus: profile?.deployment_status,
    readinessReady: paper.ready,
    strategyModeDisabled: (modeOverride ?? entry.strategyMode) === 'DISABLED',
  });
  const effectiveStrategyMode = resolveEffectiveStrategyMode(
    entry.strategyId,
    undefined,
    modeOverride,
  );

  return {
    strategyId: entry.strategyId,
    displayName: entry.displayName,
    category: entry.category,
    categoryLabel: categoryLabel(entry.category),
    direction: entry.direction === 'short' ? 'SELL' : entry.direction === 'neutral' ? 'BOTH' : 'BUY',
    marketType: 'Equity',
    riskProfile: entry.riskProfile,
    riskProfileLabel: riskProfileLabel(entry.riskProfile),
    timeframe: entry.timeframe,
    timeframeLabel: timeframeLabel(entry.timeframe),
    explanation: entry.explanationTemplate,
    isFeatured: isFeaturedStrategy(entry.strategyId),
    isActiveInRunner: activeInRunner,
    deploymentStatus: profile?.deployment_status ?? paper.deploymentStatus,
    deploymentLifecycle,
    paperTradingReady: paperReady,
    strategyMode: effectiveStrategyMode,
    registryStrategyMode: entry.strategyMode,
    hasModeOverride: modeOverride != null,
    effectiveStrategyMode,
    cardStatus: cardStatus(entry, paperReady, activeInRunner, effectiveStrategyMode),
  };
}

export function mapEntryToDetail(
  entry: StrategyRegistryEntry,
  profile?: StrategyProfileRow | null,
): StrategyHubDetail {
  const summary = mapEntryToSummary(entry, profile);
  const paper = assessPaperTradingReadiness(entry.strategyId, {
    hasEvaluator: EVALUATOR_STRATEGIES.has(entry.strategyId),
    isActiveInRunner: ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId),
    profile,
  });

  return {
    ...summary,
    entryType: entry.entryType,
    invalidation: entry.invalidationLogic,
    allowedRegimes: entry.allowedRegimes,
    blockedRegimes: entry.blockedRegimes,
    idealMarketRegime: entry.idealMarketRegime,
    idealRsiRange: entry.idealRsiRange,
    minAdx: entry.minAdx,
    minVolumeExpansion: entry.minVolumeExpansion,
    defaultConfidenceWeight: entry.defaultConfidenceWeight,
    hasEvaluator: EVALUATOR_STRATEGIES.has(entry.strategyId),
    paperTrading: paper,
    performance: null,
    profileNotes: profile?.notes ?? null,
    version: profile?.version ?? '1.0.0',
  };
}

export function loadAllStrategySummaries(
  profiles?: Map<string, StrategyProfileRow>,
): StrategyHubSummary[] {
  return listRegistryStrategyIds()
    .map((id) => {
      const entry = STRATEGY_REGISTRY[id];
      return mapEntryToSummary(entry, profiles?.get(id));
    })
    .sort((a, b) => {
      if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
}

export function loadStrategyDetail(
  strategyId: string,
  profile?: StrategyProfileRow | null,
): StrategyHubDetail | null {
  const entry = getRegistryEntry(strategyId);
  if (!entry) return null;
  return mapEntryToDetail(entry, profile);
}

export function filterByCategory(
  strategies: StrategyHubSummary[],
  category: string | null,
): StrategyHubSummary[] {
  if (!category) return strategies;
  return strategies.filter((s) => s.category === category);
}
