// ════════════════════════════════════════════════════════════════
//  Volume Feature Builder
// ════════════════════════════════════════════════════════════════

import type { VolumeFeatures, Candle } from '../types/signalEngine.types';
import { volumes, lastCandle } from '../utils/candles';
import { latestObv, obvSlope } from '../indicators/obv';
import { latestVwap } from '../indicators/vwap';
import { mean, round, safeDivide } from '../utils/math';
import { VOLUME_AVG_PERIOD, OBV_SLOPE_PERIOD, VWAP_PERIOD, VOLUME_CLIMAX_THRESHOLD } from '../constants/signalEngine.constants';

export function buildVolumeFeatures(candles: Candle[]): VolumeFeatures {
  const current = lastCandle(candles);
  const volSeries = volumes(candles);
  const len = volSeries.length;

  // Average volume of the 20 candles before the current one
  const lookbackStart = Math.max(0, len - VOLUME_AVG_PERIOD - 1);
  const lookbackEnd = len - 1;
  const lookbackVols = lookbackEnd > lookbackStart
    ? volSeries.slice(lookbackStart, lookbackEnd)
    : [];
  const avgVolume20 = lookbackVols.length > 0 ? round(mean(lookbackVols), 0) : 0;

  const volumeVs20dAvg = round(safeDivide(current.volume, avgVolume20), 2);

  // Breakout volume ratio: current volume vs max volume in lookback
  const maxLookbackVol = lookbackVols.length > 0 ? Math.max(...lookbackVols) : 1;
  const breakoutVolumeRatio = round(safeDivide(current.volume, maxLookbackVol > 0 ? maxLookbackVol : 1), 2);

  // OBV and OBV slope
  const obv = latestObv(candles);
  const obvSlopeVal = obvSlope(candles, OBV_SLOPE_PERIOD);

  // Rolling VWAP
  const vwap = latestVwap(candles, VWAP_PERIOD);

  // Volume climax: extreme volume spike relative to average
  const volumeClimaxRatio = avgVolume20 > 0 ? round(current.volume / avgVolume20, 2) : 0;

  return {
    volume: current.volume,
    avgVolume20,
    volumeVs20dAvg,
    breakoutVolumeRatio,
    obv: round(obv, 0),
    obvSlope: round(obvSlopeVal),
    vwap: round(isNaN(vwap) ? current.close : vwap),
    volumeClimaxRatio,
  };
}
