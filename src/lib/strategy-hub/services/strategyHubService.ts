// ════════════════════════════════════════════════════════════════
//  Strategy Hub Service — orchestrates registry + metrics + filters
// ════════════════════════════════════════════════════════════════

import { buildCategoryIndex } from '../categories';
import {
  FEATURED_STRATEGY_IDS,
  filterByCategory,
  loadStrategyDetail,
} from '../registry';
import { loadAllStrategyProfiles, loadStrategyProfile } from '../repository/strategyProfiles';
import { loadStrategyConditions } from '../repository/strategyCatalog';
import { listStrategiesFromRegistry } from './strategyRegistryService';
import { attachMetricsToSummaries, loadStrategyMetrics } from './strategyMetricsService';
import type { PerformanceWindow } from '@/lib/strategies/strategyPerformance';
import type {
  StrategyHubDetail,
  StrategyHubListResponse,
  StrategyConditionRow,
} from '../types';

export interface HubListOptions {
  category?: string | null;
  featuredOnly?: boolean;
  paperReadyOnly?: boolean;
  window?: PerformanceWindow;
}

export async function loadStrategyHub(options: HubListOptions = {}): Promise<StrategyHubListResponse> {
  let strategies = await listStrategiesFromRegistry();

  if (options.featuredOnly) {
    strategies = strategies.filter((s) => FEATURED_STRATEGY_IDS.includes(s.strategyId as never));
  }
  if (options.paperReadyOnly) {
    strategies = strategies.filter((s) => s.paperTradingReady);
  }
  strategies = filterByCategory(strategies, options.category ?? null);

  const window = options.window ?? '90D';
  strategies = await attachMetricsToSummaries(strategies, window);

  const allForCounts = await listStrategiesFromRegistry();
  const categoryCounts: Partial<Record<string, number>> = {};
  for (const s of allForCounts) {
    categoryCounts[s.category] = (categoryCounts[s.category] ?? 0) + 1;
  }

  const featured = await attachMetricsToSummaries(
    strategies.filter((s) => s.isFeatured),
    window,
  );

  return {
    strategies,
    featured,
    categories: buildCategoryIndex(categoryCounts),
    total: strategies.length,
  };
}

export async function loadStrategyHubDetail(
  strategyId: string,
  window: PerformanceWindow = '90D',
): Promise<(StrategyHubDetail & { conditions: StrategyConditionRow[] }) | null> {
  const profile = await loadStrategyProfile(strategyId);
  const detail = loadStrategyDetail(strategyId, profile);
  if (!detail) return null;

  const [{ summary, detail: perfDetail }, conditions] = await Promise.all([
    loadStrategyMetrics(strategyId, window),
    loadStrategyConditions(strategyId),
  ]);

  return {
    ...detail,
    performance: summary,
    performanceDetail: perfDetail,
    conditions,
  };
}
