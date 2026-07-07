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
  timeframe?: string | null;
  direction?: string | null;
  marketType?: string | null;
  status?: string | null;
  risk?: string | null;
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
  if (options.timeframe) {
    strategies = strategies.filter((s) => {
      const requested = options.timeframe?.toLowerCase();
      if (requested === 'positional') return s.timeframe.toLowerCase() === 'swing';
      return s.timeframe.toLowerCase() === requested;
    });
  }
  if (options.direction) {
    strategies = strategies.filter((s) => s.direction === options.direction);
  }
  if (options.marketType) {
    strategies = strategies.filter((s) => s.marketType.toLowerCase() === options.marketType?.toLowerCase());
  }
  if (options.status && options.status.toLowerCase() !== 'backtested') {
    strategies = strategies.filter((s) => s.cardStatus.toLowerCase() === options.status?.toLowerCase());
  }
  if (options.risk) {
    strategies = strategies.filter((s) => s.riskProfile === options.risk);
  }

  const window = options.window ?? '90D';
  strategies = await attachMetricsToSummaries(strategies, window);
  if (options.status?.toLowerCase() === 'backtested') {
    strategies = strategies.filter((s) => s.cardStatus === 'Backtested');
  }

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
