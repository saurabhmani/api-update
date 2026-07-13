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
import { isLiquid } from '../utils/validation';
import { MIN_AVG_VOLUME, MIN_PRICE } from '../constants/signalEngine.constants';

export function buildSignalFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = MIN_AVG_VOLUME,
  minPrice = MIN_PRICE,
): SignalFeatures {
  const integrity = validateCandleSeriesIntegrity(candles);
  const series = integrity.candles.length > 0 ? integrity.candles : candles;

  const trend = buildTrendFeatures(series);
  const momentum = buildMomentumFeatures(series);
  const volume = buildVolumeFeatures(series);
  const volatility = buildVolatilityFeatures(series);
  const structure = buildStructureFeatures(series);

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
