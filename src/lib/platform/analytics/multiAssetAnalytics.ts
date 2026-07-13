// ════════════════════════════════════════════════════════════════
//  Phase 6 — Multi-Asset Analytics Expansion
// ════════════════════════════════════════════════════════════════

import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';
import { aggregatePerformanceMetrics } from '@/lib/signal-engine/analytics/performanceAnalytics';
import { getStrategyDefinition } from '../strategyRegistry';
import { resolveAssetForSymbol } from '../assetRegistry';
import type { AssetClass } from '../types';

export const MULTI_ASSET_ANALYTICS_VERSION = '6.0.0';

export type MultiAssetDimension =
  | 'assetClass'
  | 'strategyFamily'
  | 'marketSession'
  | 'currency'
  | 'region';

export interface EnrichedOutcomeRecord extends OutcomeAnalyticsRecord {
  assetClass?: AssetClass;
  strategyFamily?: string;
  marketSession?: string;
  currency?: string;
  region?: string;
}

export function enrichOutcomeRecord(
  record: OutcomeAnalyticsRecord,
  meta?: {
    assetClass?: AssetClass;
    exchange?: string;
    marketSession?: string;
  },
): EnrichedOutcomeRecord {
  const asset = resolveAssetForSymbol(record.symbol, meta?.exchange ?? 'NSE', meta?.assetClass ?? 'equity');
  const strategy = getStrategyDefinition(record.strategy);
  return {
    ...record,
    assetClass: meta?.assetClass ?? asset.assetClass,
    strategyFamily: strategy?.family ?? 'breakout',
    marketSession: meta?.marketSession ?? 'regular',
    currency: asset.currency,
    region: asset.region,
  };
}

function keyForEnriched(record: EnrichedOutcomeRecord, dimension: MultiAssetDimension): string {
  switch (dimension) {
    case 'assetClass': return record.assetClass ?? 'equity';
    case 'strategyFamily': return record.strategyFamily ?? 'unknown';
    case 'marketSession': return record.marketSession ?? 'regular';
    case 'currency': return record.currency ?? 'INR';
    case 'region': return record.region ?? 'IN';
  }
}

export function aggregateMultiAssetMetrics(
  records: readonly EnrichedOutcomeRecord[],
  dimension: MultiAssetDimension,
) {
  const synthetic = records.map((r) => ({
    ...r,
    strategy: dimension === 'strategyFamily' ? (r.strategyFamily ?? r.strategy) : r.strategy,
    sector: dimension === 'assetClass' ? (r.assetClass ?? 'equity') : r.sector,
    symbol: dimension === 'currency' ? (r.currency ?? 'INR') : r.symbol,
    marketRegime: dimension === 'marketSession' ? (r.marketSession ?? 'regular') : r.marketRegime,
    timeframe: dimension === 'region' ? (r.region ?? 'IN') : r.timeframe,
  }));

  const mapDimension = {
    assetClass: 'sector' as const,
    strategyFamily: 'strategy' as const,
    marketSession: 'marketRegime' as const,
    currency: 'symbol' as const,
    region: 'timeframe' as const,
  };

  return aggregatePerformanceMetrics(synthetic, mapDimension[dimension]);
}

export function buildAllMultiAssetDimensions(
  records: readonly OutcomeAnalyticsRecord[],
): Record<MultiAssetDimension, ReturnType<typeof aggregateMultiAssetMetrics>> {
  const enriched = records.map((r) => enrichOutcomeRecord(r));
  const dimensions: MultiAssetDimension[] = [
    'assetClass', 'strategyFamily', 'marketSession', 'currency', 'region',
  ];
  return Object.fromEntries(
    dimensions.map((d) => [d, aggregateMultiAssetMetrics(enriched, d)]),
  ) as Record<MultiAssetDimension, ReturnType<typeof aggregateMultiAssetMetrics>>;
}
