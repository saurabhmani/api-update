// Index adapter — same feature shape as equity; liquidity thresholds relaxed.
import type { Candle, MarketRegimeLabel, RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { MIN_AVG_VOLUME, MIN_PRICE } from '@/lib/signal-engine/constants/signalEngine.constants';

export function buildIndexFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = MIN_AVG_VOLUME * 0.5,
  minPrice = MIN_PRICE * 0.1,
  relativeStrength?: RelativeStrengthFeatures,
): SignalFeatures {
  return buildSignalFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
}
