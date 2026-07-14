// ════════════════════════════════════════════════════════════════
//  Confirmed Swing Anchors — Product A Phase 5 (Fibonacci 2.0)
//
//  ATR-aware pivot selection with confirmation delay. Never uses
//  future bars beyond `asOfIndex` to confirm a pivot (no look-ahead).
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';
import { latestAtr } from '../indicators/atr';
import { round, safeDivide } from '../utils/math';

export const SWING_ANCHOR_VERSION = '2.0.0';

export interface SwingPivot {
  index: number;
  ts: string;
  price: number;
  kind: 'high' | 'low';
}

export interface ConfirmedImpulseAnchors {
  swingLow: SwingPivot;
  swingHigh: SwingPivot;
  /** Impulse size / ATR. */
  impulseAtrMultiple: number;
  impulseBars: number;
  /** Net move / path length (0–1). */
  directionalEfficiency: number;
  /** Overlap/chop proxy 0–1 (lower is cleaner). */
  chopRatio: number;
  volumeProfileOk: boolean;
  atr: number;
  valid: boolean;
  rejectReason?: string;
  modelVersion: string;
}

export interface SwingAnchorOptions {
  /** Last usable bar index (inclusive). Defaults to candles.length - 1. */
  asOfIndex?: number;
  pivotLeft?: number;
  /** Bars after pivot required for confirmation (look-ahead safe). */
  pivotConfirmDelay?: number;
  minBarsBetweenPivots?: number;
  minImpulseAtr?: number;
  /** Max age of swing high in bars from asOf. */
  maxAnchorAgeBars?: number;
  prominenceAtr?: number;
}

const DEFAULTS = {
  pivotLeft: 2,
  pivotConfirmDelay: 2,
  minBarsBetweenPivots: 5,
  minImpulseAtr: 1.5,
  maxAnchorAgeBars: 60,
  prominenceAtr: 0.35,
};

/**
 * Find confirmed pivot lows/highs up to asOfIndex.
 * Pivot at i is confirmed only when i + pivotConfirmDelay <= asOfIndex
 * and confirming bars do not violate the pivot extreme.
 */
export function findConfirmedPivots(
  candles: Candle[],
  asOfIndex: number,
  atr: number,
  opts: Required<Pick<SwingAnchorOptions, 'pivotLeft' | 'pivotConfirmDelay' | 'prominenceAtr'>>,
): { lows: SwingPivot[]; highs: SwingPivot[] } {
  const lows: SwingPivot[] = [];
  const highs: SwingPivot[] = [];
  const L = opts.pivotLeft;
  const D = opts.pivotConfirmDelay;
  const prom = atr * opts.prominenceAtr;

  for (let i = L; i <= asOfIndex - D; i++) {
    const c = candles[i];
    let isLow = true;
    let isHigh = true;
    for (let j = i - L; j <= i + D; j++) {
      if (j === i) continue;
      if (j < 0 || j > asOfIndex) {
        isLow = false;
        isHigh = false;
        break;
      }
      if (candles[j].low <= c.low) isLow = false;
      if (candles[j].high >= c.high) isHigh = false;
    }
    if (isLow) {
      // Prominence vs local neighbours
      const left = candles[i - 1]?.low ?? c.low;
      const right = candles[i + 1]?.low ?? c.low;
      if (Math.min(left, right) - c.low >= prom * 0.25 || prom <= 0) {
        lows.push({ index: i, ts: c.ts, price: c.low, kind: 'low' });
      }
    }
    if (isHigh) {
      const left = candles[i - 1]?.high ?? c.high;
      const right = candles[i + 1]?.high ?? c.high;
      if (c.high - Math.max(left, right) >= prom * 0.25 || prom <= 0) {
        highs.push({ index: i, ts: c.ts, price: c.high, kind: 'high' });
      }
    }
  }
  return { lows, highs };
}

function directionalEfficiency(candles: Candle[], from: number, to: number): number {
  if (to <= from) return 0;
  const net = candles[to].close - candles[from].close;
  let path = 0;
  for (let i = from + 1; i <= to; i++) {
    path += Math.abs(candles[i].close - candles[i - 1].close);
  }
  return Math.max(0, Math.min(1, safeDivide(Math.abs(net), path)));
}

function chopRatio(candles: Candle[], from: number, to: number): number {
  if (to <= from + 1) return 1;
  let overlaps = 0;
  let n = 0;
  for (let i = from + 1; i <= to; i++) {
    const a = candles[i - 1];
    const b = candles[i];
    const overlap = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low));
    const range = Math.max(a.high - a.low, b.high - b.low, 1e-9);
    overlaps += overlap / range;
    n++;
  }
  return n === 0 ? 1 : overlaps / n;
}

function volumeProfileOk(candles: Candle[], from: number, to: number): boolean {
  if (to <= from) return false;
  const impulse = candles.slice(from, to + 1);
  const vols = impulse.map((c) => c.volume || 0);
  const avg = vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length);
  const priorStart = Math.max(0, from - impulse.length);
  const prior = candles.slice(priorStart, from);
  if (prior.length < 3) return avg > 0;
  const priorAvg = prior.reduce((s, c) => s + (c.volume || 0), 0) / prior.length;
  return priorAvg <= 0 ? avg > 0 : avg >= priorAvg * 0.7;
}

/** Unexplained overnight jump (>15%) within the impulse — treat as CA discontinuity. */
function hasUnexplainedDiscontinuity(candles: Candle[], from: number, to: number): boolean {
  for (let i = from + 1; i <= to; i++) {
    const prevClose = candles[i - 1].close;
    const open = candles[i].open;
    if (prevClose > 0 && Math.abs(open - prevClose) / prevClose > 0.15) {
      return true;
    }
  }
  return false;
}

/**
 * Select the most recent valid bullish impulse (swing low → later swing high).
 * Prefers recency over widest range. Timestamp-safe at asOfIndex.
 */
export function selectConfirmedBullishImpulse(
  candles: Candle[],
  options: SwingAnchorOptions = {},
): ConfirmedImpulseAnchors | null {
  if (candles.length < 30) return null;

  const asOfIndex = Math.min(
    options.asOfIndex ?? candles.length - 1,
    candles.length - 1,
  );
  if (asOfIndex < 20) return null;

  const cfg = {
    pivotLeft: options.pivotLeft ?? DEFAULTS.pivotLeft,
    pivotConfirmDelay: options.pivotConfirmDelay ?? DEFAULTS.pivotConfirmDelay,
    minBarsBetweenPivots: options.minBarsBetweenPivots ?? DEFAULTS.minBarsBetweenPivots,
    minImpulseAtr: options.minImpulseAtr ?? DEFAULTS.minImpulseAtr,
    maxAnchorAgeBars: options.maxAnchorAgeBars ?? DEFAULTS.maxAnchorAgeBars,
    prominenceAtr: options.prominenceAtr ?? DEFAULTS.prominenceAtr,
  };

  const atrSeriesSlice = candles.slice(0, asOfIndex + 1);
  const atr = latestAtr(atrSeriesSlice, 14);
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const { lows, highs } = findConfirmedPivots(candles, asOfIndex, atr, cfg);

  // Most recent valid impulse first
  const candidateHighs = [...highs].reverse();
  for (const hi of candidateHighs) {
    if (asOfIndex - hi.index > cfg.maxAnchorAgeBars) continue;

    // Most recent low before this high with enough spacing
    const priorLows = lows.filter(
      (lo) => lo.index < hi.index && hi.index - lo.index >= cfg.minBarsBetweenPivots,
    );
    if (priorLows.length === 0) continue;
    const lo = priorLows[priorLows.length - 1];

    if (hi.price <= lo.price) continue;

    const impulseSize = hi.price - lo.price;
    const impulseAtrMultiple = impulseSize / atr;
    if (impulseAtrMultiple < cfg.minImpulseAtr) {
      continue;
    }

    // Bullish direction: close near the high end of impulse
    const midClose = candles[hi.index].close;
    if (midClose < lo.price + impulseSize * 0.4) continue;

    const efficiency = directionalEfficiency(candles, lo.index, hi.index);
    if (efficiency < 0.35) continue;

    const chop = chopRatio(candles, lo.index, hi.index);
    if (chop > 0.72) continue;

    if (hasUnexplainedDiscontinuity(candles, lo.index, hi.index)) {
      continue;
    }

    const volOk = volumeProfileOk(candles, lo.index, hi.index);

    return {
      swingLow: lo,
      swingHigh: hi,
      impulseAtrMultiple: round(impulseAtrMultiple, 2),
      impulseBars: hi.index - lo.index,
      directionalEfficiency: round(efficiency, 3),
      chopRatio: round(chop, 3),
      volumeProfileOk: volOk,
      atr: round(atr, 4),
      valid: volOk && efficiency >= 0.35,
      rejectReason: volOk ? undefined : 'Weak volume participation on impulse',
      modelVersion: SWING_ANCHOR_VERSION,
    };
  }

  return null;
}

/** Look-ahead safety check: confirming bars for pivots never exceed asOfIndex. */
export function assertNoLookAheadInAnchors(
  anchors: ConfirmedImpulseAnchors,
  asOfIndex: number,
  confirmDelay: number = DEFAULTS.pivotConfirmDelay,
): boolean {
  return (
    anchors.swingLow.index + confirmDelay <= asOfIndex &&
    anchors.swingHigh.index + confirmDelay <= asOfIndex &&
    anchors.swingHigh.index <= asOfIndex &&
    anchors.swingLow.index <= asOfIndex
  );
}
