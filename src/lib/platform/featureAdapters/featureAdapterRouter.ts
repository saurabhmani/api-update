// ════════════════════════════════════════════════════════════════
//  Phase 6 — Feature Adapter Router
//  Single entry — equity path delegates to buildSignalFeatures unchanged.
// ════════════════════════════════════════════════════════════════

import type { Candle, MarketRegimeLabel, RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import type { AssetDefinition } from '../types';
import { DEFAULT_NSE_EQUITY_ASSET } from '../assetRegistry';
import { buildEquityFeatures } from './equityAdapter';
import { buildCryptoFeatures } from './cryptoAdapter';
import { buildForexFeatures } from './forexAdapter';
import { buildIndexFeatures } from './indexAdapter';

export interface FeatureAdapterInput {
  asset: AssetDefinition;
  candles: Candle[];
  marketRegime: MarketRegimeLabel;
  minAvgVolume?: number;
  minPrice?: number;
  relativeStrength?: RelativeStrengthFeatures;
}

/**
 * Canonical feature build — routes to asset adapter.
 * Equity (default) uses the exact existing buildSignalFeatures path.
 */
export function buildCanonicalSignalFeatures(input: FeatureAdapterInput): SignalFeatures {
  const { asset, candles, marketRegime, minAvgVolume, minPrice, relativeStrength } = input;

  switch (asset.assetClass) {
    case 'equity':
    case 'etf':
      return buildEquityFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
    case 'index':
      return buildIndexFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
    case 'crypto':
      return buildCryptoFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
    case 'forex':
      return buildForexFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
    case 'futures':
    case 'commodity':
      return buildEquityFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
    case 'options':
      throw new Error(`Options asset ${asset.assetId} is metadata-only — no feature pipeline`);
    default:
      return buildSignalFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
  }
}

export function buildFeaturesForSymbol(
  symbol: string,
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  asset?: AssetDefinition,
  relativeStrength?: RelativeStrengthFeatures,
): SignalFeatures {
  const resolved = asset ?? { ...DEFAULT_NSE_EQUITY_ASSET, symbol, assetId: `NSE:${symbol}` };
  return buildCanonicalSignalFeatures({
    asset: resolved,
    candles,
    marketRegime,
    relativeStrength,
  });
}
