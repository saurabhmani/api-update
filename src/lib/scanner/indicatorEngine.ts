// ════════════════════════════════════════════════════════════════
//  Indicator Engine — scanner-side latest-bar snapshot
//
//  Pure-math companion to yahooDataService + preFilterEngine. Takes // @deprecated marker
//  a normalised candle series and returns a single object describing
//  the latest bar's technical state — EMAs, Wilder's RSI/ATR, 20-bar
//  range and volume, gap, return volatility, EMA distance.
//
//  Contract
//    • Pure function. Never throws.
//    • Insufficient history per-indicator → that field returns null
//      and a stable warning code is appended to `warnings[]`. The
//      caller can then either reject the candidate or proceed with
//      the partial snapshot — that policy decision lives in the
//      scanner, not here.
//    • All percentages are signed (gap, EMA distance) — sign tells
//      direction.
//    • Wilder smoothing is used for both RSI and ATR (matches the
//      live signal-engine indicators in src/lib/signal-engine/indicators).
// ════════════════════════════════════════════════════════════════

import type { NormalizedCandle } from './yahooDataService'; // @deprecated marker

// ── Public types ─────────────────────────────────────────────────

export interface IndicatorSnapshot {
  /** Latest bar reference. null when no candles. */
  date:      string | null;
  close:     number | null;
  open:      number | null;
  high:      number | null;
  low:       number | null;
  volume:    number | null;
  prevClose: number | null;

  /** Trend EMAs. */
  ema20: number | null;
  ema50: number | null;

  /** Distance of latest close from each EMA, % signed. */
  distEma20Pct: number | null;
  distEma50Pct: number | null;

  /** Wilder's RSI(14). 0–100, null when <15 bars. */
  rsi14: number | null;

  /** Trailing average volume across last 20 bars. */
  avgVolume20: number | null;

  /** 20-bar max(high), min(low). */
  high20: number | null;
  low20:  number | null;

  /** Wilder's ATR(14). */
  atr14: number | null;

  /** Stdev of last 20 close-to-close log returns × 100, per-bar (not annualised). */
  volatilityPct: number | null;

  /** Gap from prior session close into today's open, % signed. */
  gapPct: number | null;

  /** Series length passed in. Helpful for downstream gating. */
  candleCount: number;

  /** Stable codes for indicators that could not be computed. Empty when all resolved. */
  warnings: string[];
}

// ── Public entry ─────────────────────────────────────────────────

/**
 * Compute the indicator snapshot for the LATEST bar in a normalised
 * candle series. Always returns a fully-shaped object; missing values
 * are null and accompanied by a `warnings[]` entry.
 */
export function computeIndicators(
  candles: NormalizedCandle[] | null | undefined,
): IndicatorSnapshot {
  if (!candles || candles.length === 0) {
    return emptySnapshot(0, ['no_candles']);
  }

  const n = candles.length;
  const last = candles[n - 1];
  const prev = n >= 2 ? candles[n - 2] : null;
  const warnings: string[] = [];

  // Project to numeric arrays once. NaN is the sentinel for missing
  // — null math silently drops contributions, NaN propagates so we
  // can detect and skip rather than emit a wrong value.
  const closes  = candles.map((c) => (Number.isFinite(c.close)  ? c.close  : NaN));
  const highs   = candles.map((c) => (Number.isFinite(c.high)   ? c.high   : NaN));
  const lows    = candles.map((c) => (Number.isFinite(c.low)    ? c.low    : NaN));
  const volumes = candles.map((c) => (Number.isFinite(c.volume) ? c.volume : NaN));

  const lastClose = Number.isFinite(last.close)  ? last.close  : null;
  const lastOpen  = Number.isFinite(last.open)   ? last.open   : null;
  const lastHigh  = Number.isFinite(last.high)   ? last.high   : null;
  const lastLow   = Number.isFinite(last.low)    ? last.low    : null;
  const lastVol   = Number.isFinite(last.volume) ? last.volume : null;
  const prevClose = prev && Number.isFinite(prev.close) ? prev.close : null;

  if (lastClose == null) warnings.push('latest_close_invalid');

  // ── Trend ──
  const ema20 = computeEma(closes, 20);
  const ema50 = computeEma(closes, 50);
  if (ema20 == null) warnings.push('ema20_insufficient_history');
  if (ema50 == null) warnings.push('ema50_insufficient_history');

  const distEma20Pct =
    ema20 != null && lastClose != null && ema20 > 0
      ? ((lastClose - ema20) / ema20) * 100
      : null;
  const distEma50Pct =
    ema50 != null && lastClose != null && ema50 > 0
      ? ((lastClose - ema50) / ema50) * 100
      : null;

  // ── Momentum ──
  const rsi14 = computeWilderRsi(closes, 14);
  if (rsi14 == null) warnings.push('rsi14_insufficient_history');

  // ── 20-bar volume / high / low ──
  const tail20 = candles.slice(-20);
  let volSum = 0;
  let volCount = 0;
  let high20: number = -Infinity;
  let low20:  number =  Infinity;
  for (const c of tail20) {
    if (Number.isFinite(c.volume)) {
      volSum   += c.volume;
      volCount += 1;
    }
    if (Number.isFinite(c.high) && c.high > high20) high20 = c.high;
    if (Number.isFinite(c.low)  && c.low  < low20)  low20  = c.low;
  }
  const avgVolume20 = volCount > 0 ? volSum / volCount : null;
  if (avgVolume20 == null) warnings.push('avgVolume20_no_data');
  if (n < 20) warnings.push('window20_partial');

  // ── Volatility ──
  const atr14 = computeWilderAtr(highs, lows, closes, 14);
  if (atr14 == null) warnings.push('atr14_insufficient_history');

  const volatilityPct = computeReturnVolatilityPct(closes, 20);
  if (volatilityPct == null) warnings.push('volatilityPct_insufficient_history');

  // ── Gap ──
  const gapPct =
    prevClose != null && prevClose > 0 && lastOpen != null
      ? ((lastOpen - prevClose) / prevClose) * 100
      : null;
  if (gapPct == null) warnings.push('gapPct_no_prev_bar');

  // Suppress unused-binding noise — `volumes` is built so every
  // numeric source is normalised in one place; keep for symmetry.
  void volumes;

  return {
    date:      last.date ?? null,
    close:     lastClose,
    open:      lastOpen,
    high:      lastHigh,
    low:       lastLow,
    volume:    lastVol,
    prevClose,

    ema20,
    ema50,
    distEma20Pct,
    distEma50Pct,

    rsi14,

    avgVolume20,

    high20: Number.isFinite(high20) ? high20 : null,
    low20:  Number.isFinite(low20)  ? low20  : null,

    atr14,
    volatilityPct,

    gapPct,

    candleCount: n,
    warnings,
  };
}

// ── Indicator math (Wilder's conventions) ────────────────────────

function emptySnapshot(count: number, warnings: string[]): IndicatorSnapshot {
  return {
    date: null, close: null, open: null, high: null, low: null, volume: null, prevClose: null,
    ema20: null, ema50: null, distEma20Pct: null, distEma50Pct: null,
    rsi14: null,
    avgVolume20: null,
    high20: null, low20: null,
    atr14: null, volatilityPct: null,
    gapPct: null,
    candleCount: count,
    warnings,
  };
}

/**
 * Standard EMA: seeded with SMA over the first `period` values, then
 * recursive `ema_t = v_t × k + ema_{t-1} × (1 − k)`, k = 2/(period+1).
 * Returns null when the series is shorter than `period` or the seed
 * window contains a non-finite value (we won't fabricate from gaps).
 */
function computeEma(values: number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    if (!Number.isFinite(values[i])) return null;
    sum += values[i];
  }
  let ema = sum / period;

  for (let i = period; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;  // hold prior ema across a gap
    ema = v * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Wilder's RSI. Initial avg gain/loss over the first `period` deltas;
 * subsequent values use Wilder smoothing (α = 1/period).
 * Returns 100 when avgLoss is exactly zero (all-up streak), null when
 * insufficient data.
 */
function computeWilderRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const diff = b - a;
    if (diff > 0) gainSum += diff;
    else if (diff < 0) lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const diff = b - a;
    const gain = diff > 0 ?  diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Wilder's ATR. Initial value is the simple average of the first
 * `period` true ranges; subsequent values use Wilder smoothing.
 * Returns null when there are <period+1 bars (need at least one TR
 * per bar in the seed window, and each TR needs the prior close).
 */
function computeWilderAtr(
  highs:  number[],
  lows:   number[],
  closes: number[],
  period: number,
): number | null {
  if (highs.length < period + 1) return null;

  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const h  = highs[i];
    const l  = lows[i];
    const pc = closes[i - 1];
    if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(pc)) {
      trs.push(NaN);
      continue;
    }
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;

  let trSum = 0;
  for (let i = 0; i < period; i++) {
    if (!Number.isFinite(trs[i])) return null;
    trSum += trs[i];
  }
  let atr = trSum / period;

  for (let i = period; i < trs.length; i++) {
    const tr = trs[i];
    if (!Number.isFinite(tr)) continue;
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

/**
 * Sample stdev (n-1) of the last `period` close-to-close log returns,
 * × 100. Per-bar, NOT annualised — annualisation is the caller's
 * judgement call (×√252 for daily bars). Returns null when fewer than
 * 2 valid returns can be formed.
 */
function computeReturnVolatilityPct(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const start = closes.length - period;
  const returns: number[] = [];
  for (let i = start; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) continue;
    returns.push(Math.log(b / a));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  let sse = 0;
  for (const r of returns) sse += (r - mean) * (r - mean);
  const stdev = Math.sqrt(sse / (returns.length - 1));
  return stdev * 100;
}
