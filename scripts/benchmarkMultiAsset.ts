#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { listAssets } from '@/lib/platform/assetRegistry';
import { listStrategyDefinitions } from '@/lib/platform/strategyRegistry';
import { buildCanonicalSignalFeatures } from '@/lib/platform/featureAdapters/featureAdapterRouter';
import { getSessionStatus } from '@/lib/platform/marketSessionEngine';
import { resolveMultiAssetConfig } from '@/lib/platform/multiAssetConfig';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';

function candles(n = 60): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 100,
    high: 102,
    low: 98,
    close: 100 + (i % 2),
    volume: 150_000,
  }));
}

function main(): void {
  const started = Date.now();
  const assets = listAssets();
  const strategies = listStrategyDefinitions({ assetClass: 'equity' });
  let featureBuilds = 0;

  for (const asset of assets.filter((a) => !a.metadataOnly)) {
    try {
      buildCanonicalSignalFeatures({ asset, candles: candles(), marketRegime: 'Bullish' });
      featureBuilds += 1;
      getSessionStatus(asset);
      resolveMultiAssetConfig({ assetClass: asset.assetClass });
    } catch {
      // options metadata-only skipped
    }
  }

  console.log(JSON.stringify({
    benchmark: 'multi-asset',
    assetCount: assets.length,
    equityStrategyCount: strategies.length,
    featureBuilds,
    elapsedMs: Date.now() - started,
  }, null, 2));
}

main();
