// ════════════════════════════════════════════════════════════════
//  Unified Signal Feature Builder
// ════════════════════════════════════════════════════════════════

import type { Candle, SignalFeatures, MarketRegimeLabel } from '../types/signalEngine.types';
import { buildTrendFeatures } from './buildTrendFeatures';
import { buildMomentumFeatures } from './buildMomentumFeatures';
import { buildVolumeFeatures } from './buildVolumeFeatures';
import { buildVolatilityFeatures } from './buildVolatilityFeatures';
import { buildStructureFeatures } from './buildStructureFeatures';
import { isLiquid } from '../utils/validation';
import { MIN_AVG_VOLUME, MIN_PRICE } from '../constants/signalEngine.constants';

export function buildSignalFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = MIN_AVG_VOLUME,
  minPrice = MIN_PRICE,
): SignalFeatures {
  const trend = buildTrendFeatures(candles);
  const momentum = buildMomentumFeatures(candles);
  const volume = buildVolumeFeatures(candles);
  const volatility = buildVolatilityFeatures(candles);
  const structure = buildStructureFeatures(candles);

  const liquidityPass = isLiquid(volume.avgVolume20, trend.close, minAvgVolume, minPrice);

  return {
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
}
