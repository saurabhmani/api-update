// ════════════════════════════════════════════════════════════════
//  Volatility Feature Builder
// ════════════════════════════════════════════════════════════════

import type { VolatilityFeatures, Candle } from '../types/signalEngine.types';
import { latestAtr } from '../indicators/atr';
import { latestBollinger, isSqueezed } from '../indicators/bollingerBands';
import { lastCandle, previousCandle, closes } from '../utils/candles';
import { round, safeDivide, pctChange } from '../utils/math';
import { ATR_PERIOD, BOLLINGER_PERIOD, BOLLINGER_STD_DEV } from '../constants/signalEngine.constants';

export function buildVolatilityFeatures(candles: Candle[]): VolatilityFeatures {
  const current = lastCandle(candles);
  const prev = previousCandle(candles);
  const closePrices = closes(candles);
  const atr14 = latestAtr(candles, ATR_PERIOD);

  const atrPct = round(safeDivide(atr14, current.close) * 100);
  const dailyRangePct = round(safeDivide(current.high - current.low, current.close) * 100);
  const gapPct = round(pctChange(current.open, prev.close));

  // Bollinger Bands
  const bb = latestBollinger(closePrices, BOLLINGER_PERIOD, BOLLINGER_STD_DEV);
  const squeezed = isSqueezed(closePrices, BOLLINGER_PERIOD, BOLLINGER_STD_DEV);

  return {
    atr14: round(isNaN(atr14) ? 0 : atr14),
    atrPct,
    dailyRangePct,
    gapPct,
    bollingerUpper: round(isNaN(bb.upper) ? 0 : bb.upper),
    bollingerLower: round(isNaN(bb.lower) ? 0 : bb.lower),
    bollingerWidth: round(isNaN(bb.width) ? 0 : bb.width, 4),
    bollingerPctB: round(isNaN(bb.pctB) ? 0.5 : bb.pctB, 4),
    squeezed,
  };
}
