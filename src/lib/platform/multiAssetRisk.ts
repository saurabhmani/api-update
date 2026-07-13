// ════════════════════════════════════════════════════════════════
//  Phase 6 — Multi-Asset Risk Models
// ════════════════════════════════════════════════════════════════

import type { AssetClass, AssetDefinition, MultiAssetRiskProfile } from './types';
import { roundToIndianTick } from '@/lib/signal-engine/trade-plan/tradePlanEnhancements';

const RISK_PROFILES: Record<AssetClass, MultiAssetRiskProfile> = {
  equity: {
    assetClass: 'equity',
    tickValue: 1,
    atrMultiplierDefault: 1.5,
    slippageBps: 10,
    feePerTrade: 20,
    spreadEstimateBps: 15,
    currency: 'INR',
    conversionRateToBase: 1,
  },
  index: {
    assetClass: 'index',
    tickValue: 1,
    atrMultiplierDefault: 1.2,
    slippageBps: 8,
    feePerTrade: 20,
    spreadEstimateBps: 10,
    currency: 'INR',
    conversionRateToBase: 1,
  },
  etf: {
    assetClass: 'etf',
    tickValue: 1,
    atrMultiplierDefault: 1.4,
    slippageBps: 10,
    feePerTrade: 20,
    spreadEstimateBps: 12,
    currency: 'INR',
    conversionRateToBase: 1,
  },
  futures: {
    assetClass: 'futures',
    tickValue: 50,
    atrMultiplierDefault: 1.5,
    slippageBps: 5,
    feePerTrade: 40,
    spreadEstimateBps: 5,
    currency: 'INR',
    conversionRateToBase: 1,
  },
  options: {
    assetClass: 'options',
    tickValue: 50,
    atrMultiplierDefault: 2.0,
    slippageBps: 20,
    feePerTrade: 50,
    spreadEstimateBps: 30,
    currency: 'INR',
    conversionRateToBase: 1,
  },
  forex: {
    assetClass: 'forex',
    tickValue: 10,
    atrMultiplierDefault: 1.0,
    slippageBps: 2,
    feePerTrade: 0,
    spreadEstimateBps: 3,
    currency: 'USD',
    conversionRateToBase: 83,
  },
  crypto: {
    assetClass: 'crypto',
    tickValue: 1,
    atrMultiplierDefault: 2.0,
    slippageBps: 15,
    feePerTrade: 5,
    spreadEstimateBps: 20,
    currency: 'USD',
    conversionRateToBase: 83,
  },
  commodity: {
    assetClass: 'commodity',
    tickValue: 1,
    atrMultiplierDefault: 1.8,
    slippageBps: 8,
    feePerTrade: 30,
    spreadEstimateBps: 10,
    currency: 'INR',
    conversionRateToBase: 1,
  },
};

export function getRiskProfile(assetClass: AssetClass): MultiAssetRiskProfile {
  return { ...RISK_PROFILES[assetClass] };
}

export function getRiskProfileForAsset(asset: AssetDefinition): MultiAssetRiskProfile {
  const base = getRiskProfile(asset.assetClass);
  return {
    ...base,
    currency: asset.currency,
    tickValue: base.tickValue * asset.lotSize,
  };
}

export function roundPriceForAsset(price: number, asset: AssetDefinition): number {
  if (asset.assetClass === 'equity' || asset.assetClass === 'etf' || asset.assetClass === 'index') {
    return roundToIndianTick(price);
  }
  const factor = 10 ** asset.pricePrecision;
  return Math.round(price * factor) / factor;
}

export function estimateSlippage(price: number, asset: AssetDefinition): number {
  const profile = getRiskProfileForAsset(asset);
  return price * (profile.slippageBps / 10_000);
}

export function estimateSpread(price: number, asset: AssetDefinition): number {
  const profile = getRiskProfileForAsset(asset);
  return price * (profile.spreadEstimateBps / 10_000);
}

export function computeAtrStopDistance(
  atrPct: number,
  price: number,
  asset: AssetDefinition,
  multiplier?: number,
): number {
  const profile = getRiskProfileForAsset(asset);
  const mult = multiplier ?? profile.atrMultiplierDefault;
  return price * (atrPct / 100) * mult;
}

export function computePositionSizeUnits(input: {
  asset: AssetDefinition;
  portfolioCapital: number;
  riskPct: number;
  entryPrice: number;
  stopPrice: number;
}): number {
  const profile = getRiskProfileForAsset(input.asset);
  const riskBudget = input.portfolioCapital * (input.riskPct / 100) * profile.conversionRateToBase;
  const riskPerUnit = Math.abs(input.entryPrice - input.stopPrice) * profile.tickValue;
  if (riskPerUnit <= 0) return 0;
  const units = Math.floor(riskBudget / riskPerUnit);
  return Math.max(0, Math.floor(units / input.asset.lotSize) * input.asset.lotSize);
}

export function convertToBaseCurrency(amount: number, asset: AssetDefinition): number {
  const profile = getRiskProfileForAsset(asset);
  return amount * profile.conversionRateToBase;
}
