// ════════════════════════════════════════════════════════════════
//  Phase 6 — Multi-Asset Configuration (versioned overlays)
// ════════════════════════════════════════════════════════════════

import { getSignalEngineConfig } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import { getRuntimeSignalEngineConfig } from '@/lib/signal-engine/adaptive/runtimeConfiguration';
import type { AssetClass, MultiAssetConfigOverlay, ResolvedMultiAssetConfig } from './types';
import { MULTI_ASSET_SCHEMA_VERSION } from './types';
import { getRiskProfile } from './multiAssetRisk';

export const MULTI_ASSET_CONFIG_VERSION = '6.0.0';

const ASSET_OVERRIDES: Record<AssetClass, MultiAssetConfigOverlay> = {
  equity: {},
  index: { minAvgVolume: 50_000, minPrice: 5 },
  etf: { minAvgVolume: 75_000 },
  futures: { minAvgVolume: 10_000, slippageBps: 5 },
  options: {},
  forex: { minAvgVolume: 1_000, minPrice: 0.0001, slippageBps: 2 },
  crypto: { minAvgVolume: 10_000, minPrice: 0.01, slippageBps: 15 },
  commodity: { minAvgVolume: 5_000, slippageBps: 8 },
};

const STRATEGY_OVERRIDES: Record<string, MultiAssetConfigOverlay> = {};

let runtimeOverrides: MultiAssetConfigOverlay[] = [];

export function setRuntimeMultiAssetOverrides(overlays: MultiAssetConfigOverlay[]): void {
  runtimeOverrides = [...overlays];
}

export function resolveMultiAssetConfig(input: {
  assetClass: AssetClass;
  strategyId?: string;
}): ResolvedMultiAssetConfig {
  const base = getRuntimeSignalEngineConfig().config;
  const risk = getRiskProfile(input.assetClass);
  const overlays: MultiAssetConfigOverlay[] = [
    { assetClass: input.assetClass, ...ASSET_OVERRIDES[input.assetClass] },
  ];
  if (input.strategyId && STRATEGY_OVERRIDES[input.strategyId]) {
    overlays.push({ strategyId: input.strategyId, ...STRATEGY_OVERRIDES[input.strategyId] });
  }
  overlays.push(...runtimeOverrides);

  const effective: Record<string, number> = {
    minAvgVolume: base.features.minLiquidityQuality * 1000,
    minPrice: 50,
    minRewardRisk: base.rejection.minRewardRisk,
    slippageBps: risk.slippageBps,
    maxAtrPct: base.rejection.maxAbnormalAtrPct,
  };

  for (const overlay of overlays) {
    if (overlay.minAvgVolume != null) effective.minAvgVolume = overlay.minAvgVolume;
    if (overlay.minPrice != null) effective.minPrice = overlay.minPrice;
    if (overlay.minRewardRisk != null) effective.minRewardRisk = overlay.minRewardRisk;
    if (overlay.slippageBps != null) effective.slippageBps = overlay.slippageBps;
  }

  return {
    version: MULTI_ASSET_CONFIG_VERSION,
    baseVersion: base.configVersionLabel,
    assetClass: input.assetClass,
    overlays,
    effective,
  };
}

export function getMultiAssetConfigVersion(): string {
  return MULTI_ASSET_CONFIG_VERSION;
}

export function registerStrategyConfigOverride(strategyId: string, overlay: MultiAssetConfigOverlay): void {
  STRATEGY_OVERRIDES[strategyId] = overlay;
}

/** Read-only base config reference for tests. */
export function getBaseConfigVersion(): string {
  return getSignalEngineConfig().configVersionLabel;
}
