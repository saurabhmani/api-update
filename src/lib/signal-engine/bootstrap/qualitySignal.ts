// ════════════════════════════════════════════════════════════════
//  bootstrap/qualitySignal — pure EMA/RSI/swing signal builder.
//
//  Lives outside the bootstrap script so it can be unit-tested
//  without booting the script's DB/redis side effects. Kept side-
//  effect-free: no I/O, no env reads, no logger calls.
//
//  Spec contract (BALANCE):
//    BUY  : EMA20 > EMA50  AND  RSI > 55
//    SELL : EMA20 < EMA50  AND  RSI < 45
//    Skip RSI ∈ [45, 55] (neutral) and RSI > 75 / < 25 (extreme).
//    Skip thin volume (avg 20-day vol < threshold).
//    Skip dead trends (EMA spread < 0.1%).
//    Quality floors: confidence ≥ 60, final ≥ 65, RR ≥ 1.5.
//    Stop-loss: 20-day swing low (BUY) / high (SELL); ATR fallback.
//    Target:    entry ± rMultiple × risk, rMultiple ∈ [1.5, 2.5].
// ════════════════════════════════════════════════════════════════

import { computeEma } from '@/lib/signal-engine/indicators/ema';
import { computeRsi } from '@/lib/signal-engine/indicators/rsi';

export interface DailyBar {
  ts:     Date;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface QualitySignal {
  direction:        'BUY' | 'SELL';
  entryPrice:       number;
  stopLoss:         number;
  target1:          number;
  riskReward:       number;
  confidenceScore:  number;
  finalScore:       number;
  scenario:         string;
}

export type SkipReason =
  | 'no_history'
  | 'rsi_extreme'
  | 'rsi_neutral'
  | 'thin_volume'
  | 'no_trend'
  | 'no_alignment'
  | 'invalid_risk'
  | 'rr_below_floor'
  | 'score_below_floor'
  | 'invalid_price';

export type SignalResult =
  | { kind: 'signal'; signal: QualitySignal }
  | { kind: 'skip';   reason: SkipReason };

/** Minimal price snapshot the builder reads. Avoids importing
 *  MarketSnapshot (which has many fields the builder ignores). */
export interface PriceTick {
  symbol: string;
  price:  number;
}

// ── Knobs ─────────────────────────────────────────────────────────

export const Q_CONFIDENCE_FLOOR = 60;
export const Q_FINAL_FLOOR      = 65;
export const Q_RR_FLOOR         = 1.5;

const RSI_BUY_THRESHOLD  = 55;   // RSI > 55 → BUY (with EMA20>EMA50)
const RSI_SELL_THRESHOLD = 45;   // RSI < 45 → SELL (with EMA20<EMA50)
const RSI_NEUTRAL_LO     = 45;
const RSI_NEUTRAL_HI     = 55;
const RSI_EXTREME_LO     = 25;
const RSI_EXTREME_HI     = 75;

const MIN_HISTORY_BARS = 60;
const MIN_AVG_VOLUME   = 50_000;
const SWING_LOOKBACK   = 20;

// ── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function avgTrueRange(bars: DailyBar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i];
    const p = bars[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low  - p.close),
    );
    trs.push(tr);
  }
  if (trs.length < period) return 0;
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── Public builder ───────────────────────────────────────────────

export function buildQualitySignal(snap: PriceTick, bars: DailyBar[]): SignalResult {
  if (bars.length < MIN_HISTORY_BARS) return { kind: 'skip', reason: 'no_history' };

  const closes = bars.map((b) => b.close);
  const ema20  = computeEma(closes, 20);
  const ema50  = computeEma(closes, 50);
  const rsi    = computeRsi(closes, 14);
  if (ema20.length === 0 || ema50.length === 0 || rsi.length === 0) {
    return { kind: 'skip', reason: 'no_history' };
  }

  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const lastRsi   = rsi[rsi.length - 1];
  const price     = Number.isFinite(snap.price) && snap.price > 0
    ? snap.price
    : closes[closes.length - 1];
  if (!Number.isFinite(lastEma20) || !Number.isFinite(lastEma50) || !Number.isFinite(lastRsi)) {
    return { kind: 'skip', reason: 'no_history' };
  }
  if (!Number.isFinite(price) || price <= 0) return { kind: 'skip', reason: 'invalid_price' };

  if (lastRsi > RSI_EXTREME_HI || lastRsi < RSI_EXTREME_LO) return { kind: 'skip', reason: 'rsi_extreme' };
  if (lastRsi >= RSI_NEUTRAL_LO && lastRsi <= RSI_NEUTRAL_HI) return { kind: 'skip', reason: 'rsi_neutral' };

  const volSlice = bars.slice(-20).map((b) => b.volume);
  const avgVol   = volSlice.reduce((s, v) => s + v, 0) / volSlice.length;
  if (!Number.isFinite(avgVol) || avgVol < MIN_AVG_VOLUME) return { kind: 'skip', reason: 'thin_volume' };

  const emaSpreadPct = Math.abs(lastEma20 - lastEma50) / lastEma50 * 100;
  if (emaSpreadPct < 0.1) return { kind: 'skip', reason: 'no_trend' };

  // Spec BALANCE §1 — symmetric BUY/SELL gate. The neutral skip
  // above already removed RSI ∈ [45, 55], so `> 55` / `< 45` are
  // the clean directional cuts.
  const isBuy  = lastEma20 > lastEma50 && lastRsi > RSI_BUY_THRESHOLD;
  const isSell = lastEma20 < lastEma50 && lastRsi < RSI_SELL_THRESHOLD;
  if (!isBuy && !isSell) return { kind: 'skip', reason: 'no_alignment' };
  const direction: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';

  const swingSlice = bars.slice(-SWING_LOOKBACK);
  const swingLow   = Math.min(...swingSlice.map((b) => b.low));
  const swingHigh  = Math.max(...swingSlice.map((b) => b.high));
  let stopLoss = direction === 'BUY' ? swingLow : swingHigh;

  const minStopOffset = avgTrueRange(bars, 14) * 2;
  if (direction === 'BUY' && stopLoss >= price)  stopLoss = price - minStopOffset;
  if (direction === 'SELL' && stopLoss <= price) stopLoss = price + minStopOffset;

  const risk = Math.abs(price - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return { kind: 'skip', reason: 'invalid_risk' };

  const rsiDistance = Math.min(20, Math.abs(lastRsi - 50));   // 0..20
  const rsiAlign    = rsiDistance / 20;                       // 0..1
  const spreadBonus = Math.min(5, Math.round(emaSpreadPct));  // 0..5
  const volRatio    = bars[bars.length - 1].volume / avgVol;
  const volBonus    = volRatio >= 1.2 ? 5 : volRatio >= 0.8 ? 0 : -5;

  const spreadAlign = Math.min(1, emaSpreadPct / 5);
  const volAlign    = Math.max(0, Math.min(1, (volRatio - 0.8) / 0.6));
  const alignment   = (rsiAlign + spreadAlign + volAlign) / 3;
  const rMultiple   = Math.round((1.5 + alignment * 1.0) * 10) / 10;
  const target1     = direction === 'BUY' ? price + rMultiple * risk : price - rMultiple * risk;
  const riskReward  = Math.round((Math.abs(target1 - price) / risk) * 100) / 100;
  if (riskReward < Q_RR_FLOOR) return { kind: 'skip', reason: 'rr_below_floor' };

  const confidenceScore = clamp(Math.round(65 + 15 * rsiAlign + volBonus), Q_CONFIDENCE_FLOOR, 95);
  const finalScore      = clamp(Math.round(70 + spreadBonus + 5 * rsiAlign + volBonus), Q_FINAL_FLOOR, 95);
  if (confidenceScore < Q_CONFIDENCE_FLOOR) return { kind: 'skip', reason: 'score_below_floor' };
  if (finalScore     < Q_FINAL_FLOOR)       return { kind: 'skip', reason: 'score_below_floor' };

  return {
    kind: 'signal',
    signal: {
      direction,
      entryPrice:      round4(price),
      stopLoss:        round4(stopLoss),
      target1:         round4(target1),
      riskReward,
      confidenceScore,
      finalScore,
      scenario:        `ema_rsi:rsi=${lastRsi.toFixed(1)}:spread=${emaSpreadPct.toFixed(2)}%:r=${rMultiple}`,
    },
  };
}

/** Spec BALANCE §6 — direction balance verdict. */
export function classifyBias(buy: number, sell: number): 'BALANCED' | 'BIAS_DETECTED' | 'NO_SIGNALS' {
  const total = buy + sell;
  if (total === 0) return 'NO_SIGNALS';
  const minorityShare = Math.min(buy, sell) / total;
  return minorityShare >= 0.3 ? 'BALANCED' : 'BIAS_DETECTED';
}
