// ════════════════════════════════════════════════════════════════
//  Regime Evidence — Product A Phase 3
//
//  Builds evidence from benchmark candles + optional breadth/sector
//  inputs. Never fabricates FII/DII or derivatives when unavailable.
// ════════════════════════════════════════════════════════════════

import type {
  Candle,
  RegimeEvidenceBreakdown,
  RegimeExternalEvidence,
} from '../types/signalEngine.types';
import { latestEma, computeEma } from '../indicators/ema';
import { latestRsi } from '../indicators/rsi';
import { latestAtr, computeAtr } from '../indicators/atr';
import { latestAdx } from '../indicators/adx';
import { closes, lastCandle } from '../utils/candles';
import { round, safeDivide } from '../utils/math';
import { EMA_FAST, EMA_MID, EMA_SLOW, RSI_PERIOD, ATR_PERIOD } from '../constants/signalEngine.constants';

const ATR_PERCENTILE_LOOKBACK = 60;
const DIST_ACCUM_LOOKBACK = 20;

export function buildRegimeEvidence(
  benchmarkCandles: Candle[],
  external: RegimeExternalEvidence | null | undefined = null,
): RegimeEvidenceBreakdown {
  const closePrices = closes(benchmarkCandles);
  const current = lastCandle(benchmarkCandles);

  const ema20 = latestEma(closePrices, EMA_FAST);
  const ema50 = latestEma(closePrices, EMA_MID);
  const ema200 = latestEma(closePrices, EMA_SLOW);
  const rsi = latestRsi(closePrices, RSI_PERIOD);
  const atr = latestAtr(benchmarkCandles, ATR_PERIOD);
  const atrPct = round(safeDivide(atr, current.close) * 100);

  const closeVsEma20 = round(safeDivide(current.close - ema20, ema20) * 100);
  const closeVsEma50 = round(safeDivide(current.close - ema50, ema50) * 100);
  const closeVsEma200 = round(safeDivide(current.close - ema200, ema200) * 100);
  const ema20VsEma50 = round(safeDivide(ema20 - ema50, ema50) * 100);
  const ema50VsEma200 = round(safeDivide(ema50 - ema200, ema200) * 100);

  const emaFull = computeEma(closePrices, EMA_FAST);
  const len = emaFull.length;
  const ema20SlopePct =
    len >= 6 && Number.isFinite(emaFull[len - 1]) && Number.isFinite(emaFull[len - 6]) && emaFull[len - 6] !== 0
      ? round(((emaFull[len - 1] - emaFull[len - 6]) / emaFull[len - 6]) * 100, 3)
      : 0;

  let adx: number | null = null;
  try {
    const v = latestAdx(benchmarkCandles, 14);
    adx = Number.isFinite(v) ? round(v) : null;
  } catch {
    adx = null;
  }

  const atrPercentile = computeAtrPercentile(benchmarkCandles, atrPct);
  const gapPct = computeLatestGapPct(benchmarkCandles);
  const recentGapAbsPctAvg = computeRecentGapAbsAvg(benchmarkCandles, 10);
  const { distribution, accumulation } = countDistAccumDays(benchmarkCandles, DIST_ACCUM_LOOKBACK);

  const sourcesAvailable = ['benchmark_ema', 'rsi', 'atr', 'gaps', 'dist_accum_proxy'];
  const sourcesUnavailable = ['fii_dii', 'derivatives_oi'];
  if (adx != null) sourcesAvailable.push('adx');
  else sourcesUnavailable.push('adx');
  if (atrPercentile != null) sourcesAvailable.push('atr_percentile');

  const ext = external ?? {};
  const take = (
    key: keyof RegimeExternalEvidence,
    sourceName: string,
  ): number | null => {
    const v = ext[key];
    if (v == null || !Number.isFinite(Number(v))) {
      sourcesUnavailable.push(sourceName);
      return null;
    }
    sourcesAvailable.push(sourceName);
    return Number(v);
  };

  return {
    closeVsEma20,
    closeVsEma50,
    closeVsEma200,
    ema20VsEma50,
    ema50VsEma200,
    ema20SlopePct,
    rsi: round(rsi),
    adx,
    atrPct,
    atrPercentile,
    gapPct,
    recentGapAbsPctAvg,
    advanceDeclineRatio: take('advanceDeclineRatio', 'advance_decline'),
    pctAboveEma20: take('pctAboveEma20', 'universe_pct_ema20'),
    pctAboveEma50: take('pctAboveEma50', 'universe_pct_ema50'),
    pctAboveEma200: take('pctAboveEma200', 'universe_pct_ema200'),
    newHighsVsLows: take('newHighsVsLows', 'new_highs_lows'),
    sectorParticipation: take('sectorParticipation', 'sector_participation'),
    sectorRotationConcentration: take('sectorRotationConcentration', 'sector_rotation'),
    distributionDayCount: distribution,
    accumulationDayCount: accumulation,
    sourcesAvailable: Array.from(new Set(sourcesAvailable)),
    sourcesUnavailable: Array.from(new Set(sourcesUnavailable)),
  };
}

function computeAtrPercentile(candles: Candle[], currentAtrPct: number): number | null {
  if (candles.length < ATR_PERIOD + 10) return null;
  const atrSeries = computeAtr(candles, ATR_PERIOD);
  const pcts: number[] = [];
  for (let i = Math.max(0, atrSeries.length - ATR_PERCENTILE_LOOKBACK); i < atrSeries.length; i++) {
    const a = atrSeries[i];
    const c = candles[i]?.close;
    if (!Number.isFinite(a) || !c || c <= 0) continue;
    pcts.push((a / c) * 100);
  }
  if (pcts.length < 20) return null;
  const below = pcts.filter((p) => p <= currentAtrPct).length;
  return round((below / pcts.length) * 100);
}

function computeLatestGapPct(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  if (!prev.close) return 0;
  return round(safeDivide(cur.open - prev.close, prev.close) * 100);
}

function computeRecentGapAbsAvg(candles: Candle[], n: number): number {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - n);
  let sum = 0;
  let count = 0;
  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (!prev.close) continue;
    sum += Math.abs(safeDivide(cur.open - prev.close, prev.close) * 100);
    count++;
  }
  return count === 0 ? 0 : round(sum / count);
}

function countDistAccumDays(
  candles: Candle[],
  lookback: number,
): { distribution: number; accumulation: number } {
  const start = Math.max(0, candles.length - lookback);
  const slice = candles.slice(start);
  if (slice.length < 5) return { distribution: 0, accumulation: 0 };
  const avgVol = slice.reduce((s, c) => s + (c.volume || 0), 0) / slice.length;
  let distribution = 0;
  let accumulation = 0;
  for (const c of slice) {
    const volOk = (c.volume || 0) >= avgVol * 1.1;
    if (!volOk) continue;
    if (c.close < c.open) distribution++;
    else if (c.close > c.open) accumulation++;
  }
  return { distribution, accumulation };
}
