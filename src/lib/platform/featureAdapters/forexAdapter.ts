// Forex adapter — pip-scale prices; tight spread assumptions.
import type { Candle, MarketRegimeLabel, RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';

export function buildForexFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = 1_000,
  minPrice = 0.0001,
  relativeStrength?: RelativeStrengthFeatures,
): SignalFeatures {
  return buildSignalFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
}
