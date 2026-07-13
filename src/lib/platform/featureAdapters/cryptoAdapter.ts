// Crypto adapter — 24x7 market; volume floor scaled for crypto liquidity.
import type { Candle, MarketRegimeLabel, RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';

export function buildCryptoFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = 10_000,
  minPrice = 0.01,
  relativeStrength?: RelativeStrengthFeatures,
): SignalFeatures {
  return buildSignalFeatures(candles, marketRegime, minAvgVolume, minPrice, relativeStrength);
}
