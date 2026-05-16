// ════════════════════════════════════════════════════════════════
//  Trend Feature Builder
// ════════════════════════════════════════════════════════════════

import type { TrendFeatures, Candle } from '../types/signalEngine.types';
import { latestEma } from '../indicators/ema';
import { latestSma } from '../indicators/sma';
import { closes, lastCandle } from '../utils/candles';
import { pctChange, round } from '../utils/math';
import { EMA_FAST, EMA_MID, EMA_SLOW } from '../constants/signalEngine.constants';

export function buildTrendFeatures(candles: Candle[]): TrendFeatures {
  const closePrices = closes(candles);
  const current = lastCandle(candles);

  const ema9Raw    = latestEma(closePrices, 9);
  const ema21Raw   = latestEma(closePrices, 21);
  const ema20Raw   = latestEma(closePrices, EMA_FAST);
  const ema50Raw   = latestEma(closePrices, EMA_MID);
  const ema200Raw  = latestEma(closePrices, EMA_SLOW);
  const sma200Raw  = latestSma(closePrices, 200);

  // Spec "FIX INVALID FEATURES" — when the candle history is shorter
  // than the EMA window (e.g. <200 bars for ema200), latestEma returns
  // NaN. NaN propagates into every downstream comparison
  // (closeAbove200Ema, ema50Above200, distance calcs) and silently
  // turns trend conditions false. Fall back to the next-shorter EMA
  // when a longer-window EMA is unavailable; treat sma200 the same way.
  const ema9   = Number.isFinite(ema9Raw)   ? ema9Raw   : ema20Raw;
  const ema21  = Number.isFinite(ema21Raw)  ? ema21Raw  : ema20Raw;
  const ema20  = Number.isFinite(ema20Raw)  ? ema20Raw  : current.close;
  const ema50  = Number.isFinite(ema50Raw)  ? ema50Raw  : ema20;
  const ema200 = Number.isFinite(ema200Raw) ? ema200Raw : ema50;
  const sma200 = Number.isFinite(sma200Raw) ? sma200Raw : ema200;

  return {
    close: current.close,
    open: current.open,
    ema9: round(ema9),
    ema21: round(ema21),
    ema20: round(ema20),
    ema50: round(ema50),
    ema200: round(ema200),
    sma200: round(sma200),
    closeAbove20Ema: current.close > ema20,
    closeAbove50Ema: current.close > ema50,
    closeAbove200Ema: current.close > ema200,
    ema20Above50: ema20 > ema50,
    ema50Above200: ema50 > ema200,
    distanceFrom20EmaPct: pctChange(current.close, ema20),
    distanceFrom50EmaPct: pctChange(current.close, ema50),
  };
}
