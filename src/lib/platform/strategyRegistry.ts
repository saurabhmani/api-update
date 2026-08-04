// ════════════════════════════════════════════════════════════════
//  Phase 6 — Strategy Registry (metadata-driven)
//  Wraps existing STRATEGY_REGISTRY without changing evaluators.
// ════════════════════════════════════════════════════════════════

import {
  STRATEGY_REGISTRY,
  getStrategiesForRegime,
} from '@strategy-engine';
import type { StrategyName, StrategyRegistryEntry } from '@/lib/signal-engine/types/signalEngine.types';
import type { AssetClass, StrategyDefinition, StrategyFamily } from './types';
import { MULTI_ASSET_SCHEMA_VERSION } from './types';

const CATEGORY_TO_FAMILY: Record<string, StrategyFamily> = {
  breakout: 'breakout',
  trend_following: 'trend_following',
  momentum: 'momentum',
  mean_reversion: 'mean_reversion',
  reversal: 'reversal',
  volatility: 'volatility',
  structure: 'structure',
  confirmation: 'confirmation',
};

const DEFAULT_SUPPORTED_ASSETS: AssetClass[] = ['equity', 'etf', 'index'];

const EXIT_TYPE_MAP: Record<string, string> = {
  breakout_confirmation: 'target_stop',
  range_breakout_confirmation: 'target_stop',
  trend_crossover_entry: 'trailing_stop',
  momentum_continuation_entry: 'target_stop',
  pullback_entry: 'target_stop',
  mean_reversion_entry: 'target_stop',
  reversal_entry: 'target_stop',
  divergence_entry: 'target_stop',
  structure_entry: 'target_stop',
  squeeze_breakout_entry: 'target_stop',
};

function toStrategyDefinition(entry: StrategyRegistryEntry): StrategyDefinition {
  return {
    strategyId: entry.strategyId,
    version: '1.0.0',
    displayName: entry.displayName,
    family: CATEGORY_TO_FAMILY[entry.category] ?? 'breakout',
    supportedAssets: DEFAULT_SUPPORTED_ASSETS,
    requiredFeatures: ['trend', 'momentum', 'volume', 'volatility', 'structure'],
    allowedRegimes: entry.allowedRegimes,
    minimumHistoryBars: entry.requiresIntradayData ? 60 : 30,
    riskProfile: entry.riskProfile,
    entryType: entry.entryType,
    exitType: EXIT_TYPE_MAP[entry.entryType] ?? 'target_stop',
    metadataOnly: entry.isConfirmationOnly,
  };
}

const platformRegistry = new Map<string, StrategyDefinition>();

function hydrateFromCanonicalRegistry(): void {
  for (const name of Object.keys(STRATEGY_REGISTRY) as StrategyName[]) {
    const entry = STRATEGY_REGISTRY[name];
    platformRegistry.set(name, Object.freeze(toStrategyDefinition(entry)));
  }
}

hydrateFromCanonicalRegistry();

export function getStrategyDefinition(strategyId: string): StrategyDefinition | null {
  return platformRegistry.get(strategyId) ?? null;
}

export function listStrategyDefinitions(filter?: {
  assetClass?: AssetClass;
  family?: StrategyFamily;
}): StrategyDefinition[] {
  let defs = [...platformRegistry.values()];
  if (filter?.assetClass) {
    defs = defs.filter((d) => d.supportedAssets.includes(filter.assetClass!));
  }
  if (filter?.family) {
    defs = defs.filter((d) => d.family === filter.family);
  }
  return defs;
}

export function getStrategiesForAssetAndRegime(
  assetClass: AssetClass,
  regime: string,
): StrategyDefinition[] {
  const regimeMatches = getStrategiesForRegime(regime as import('@/lib/signal-engine/types/signalEngine.types').MarketRegimeLabel);
  return regimeMatches
    .map((name) => platformRegistry.get(name))
    .filter((d): d is StrategyDefinition => d != null && d.supportedAssets.includes(assetClass));
}

export function registerStrategyDefinition(def: StrategyDefinition): void {
  platformRegistry.set(def.strategyId, Object.freeze({ ...def }));
}

export function getStrategyRegistryVersion(): string {
  return MULTI_ASSET_SCHEMA_VERSION;
}

export function getCanonicalRegistryEntry(strategyId: StrategyName): StrategyRegistryEntry {
  return STRATEGY_REGISTRY[strategyId];
}
