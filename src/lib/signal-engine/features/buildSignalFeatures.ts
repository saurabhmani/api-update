// ════════════════════════════════════════════════════════════════
//  Unified Signal Feature Builder
// ════════════════════════════════════════════════════════════════

import type { Candle, SignalFeatures, MarketRegimeLabel } from '../types/signalEngine.types';
import { validateCandleSeriesIntegrity } from '@/lib/marketData/integrity/marketDataIntegrity';
import { buildTrendFeatures } from './buildTrendFeatures';
import { buildMomentumFeatures } from './buildMomentumFeatures';
import { buildVolumeFeatures } from './buildVolumeFeatures';
import { buildVolatilityFeatures } from './buildVolatilityFeatures';
import { buildStructureFeatures } from './buildStructureFeatures';
import { buildEnhancedFeatures } from './buildEnhancedFeatures';
import { isLiquid } from '../utils/validation';
import type { RelativeStrengthFeatures } from '../types/signalEngine.types';
import { MIN_AVG_VOLUME, MIN_PRICE } from '../constants/signalEngine.constants';
import type { AssetDefinition } from '@/lib/platform/types';
import { buildCanonicalSignalFeatures } from '@/lib/platform/featureAdapters/featureAdapterRouter';

export function buildSignalFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = MIN_AVG_VOLUME,
  minPrice = MIN_PRICE,
  relativeStrength?: RelativeStrengthFeatures,
  asset?: AssetDefinition,
): SignalFeatures {
  if (asset && asset.assetClass !== 'equity') {
    return buildCanonicalSignalFeatures({
      asset,
      candles,
      marketRegime,
      minAvgVolume,
      minPrice,
      relativeStrength,
    });
  }

  const integrity = validateCandleSeriesIntegrity(candles);
  const series = integrity.candles.length > 0 ? integrity.candles : candles;

  const trend = buildTrendFeatures(series);
  const momentum = buildMomentumFeatures(series);
  const volume = buildVolumeFeatures(series);
  const volatility = buildVolatilityFeatures(series);
  const structure = buildStructureFeatures(series);

  const liquidityPass = isLiquid(volume.avgVolume20, trend.close, minAvgVolume, minPrice);

  const base: SignalFeatures = {
    trend,
    momentum,
    volume,
    volatility,
    structure,
    context: {
      marketRegime,
      liquidityPass,
    },
  };

  return {
    ...base,
    enhanced: buildEnhancedFeatures(base, relativeStrength),
  };
}
