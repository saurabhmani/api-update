// ════════════════════════════════════════════════════════════════
//  Strategy Registry Service — code registry is source of truth;
//  persists to strategy_registry + strategy_conditions tables.
// ════════════════════════════════════════════════════════════════

import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import type { StrategyName, StrategyRegistryEntry } from '@/lib/signal-engine/types/signalEngine.types';
import {
  FEATURED_STRATEGY_IDS,
  ACTIVE_RUNNER_STRATEGIES,
  listRegistryStrategyIds,
  getRegistryEntry,
  loadAllStrategySummaries,
  loadStrategyDetail,
  filterByCategory,
} from '../registry';
import {
  loadStrategyConditions,
  loadStrategyFromDb,
  syncRegistryEntryToDb,
  type StrategyDbRow,
} from '../repository/strategyCatalog';
import type { StrategyConditionRow } from '../types';
import { loadAllStrategyProfiles } from '../repository/strategyProfiles';
import type { StrategyHubDetail, StrategyHubSummary } from '../types';

export {
  FEATURED_STRATEGY_IDS,
  ACTIVE_RUNNER_STRATEGIES,
  listRegistryStrategyIds,
  getRegistryEntry,
  filterByCategory,
};

/** Confirms signal-engine registry drives evaluation — same IDs as runStrategies.ts */
export function getSignalEngineRegistry(): Record<StrategyName, StrategyRegistryEntry> {
  return STRATEGY_REGISTRY;
}

export function isRegistryDrivenStrategy(strategyId: string): boolean {
  return strategyId in STRATEGY_REGISTRY;
}

export async function listStrategiesFromRegistry(): Promise<StrategyHubSummary[]> {
  const profiles = await loadAllStrategyProfiles();
  return loadAllStrategySummaries(profiles);
}

export async function getStrategyRegistryDetail(strategyId: string): Promise<StrategyHubDetail | null> {
  const profile = (await loadAllStrategyProfiles()).get(strategyId) ?? null;
  return loadStrategyDetail(strategyId, profile);
}

export async function getStrategyConditions(strategyId: string): Promise<StrategyConditionRow[]> {
  return loadStrategyConditions(strategyId);
}

export async function getStrategyDbRecord(strategyId: string): Promise<StrategyDbRow | null> {
  return loadStrategyFromDb(strategyId);
}

/** Sync code registry entry into strategies + strategy_registry + strategy_conditions */
export async function syncStrategyToDatabase(strategyId: string): Promise<boolean> {
  const entry = getRegistryEntry(strategyId);
  if (!entry) return false;
  await syncRegistryEntryToDb(entry, FEATURED_STRATEGY_IDS.includes(strategyId as StrategyName));
  return true;
}

export async function syncAllStrategiesToDatabase(): Promise<number> {
  let count = 0;
  for (const id of listRegistryStrategyIds()) {
    if (await syncStrategyToDatabase(id)) count += 1;
  }
  return count;
}
