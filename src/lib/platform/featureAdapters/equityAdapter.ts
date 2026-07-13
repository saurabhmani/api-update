// Equity adapter — delegates 1:1 to canonical buildSignalFeatures.
import type { Candle, MarketRegimeLabel, RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';

export function buildEquityFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume?: number,
  minPrice?: number,
  relativeStrength?: RelativeStrengthFeatures,
): SignalFeatures {
  return buildSignalFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
}
