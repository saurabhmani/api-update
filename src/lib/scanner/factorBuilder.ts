// ════════════════════════════════════════════════════════════════
//  Factor Builder — indicators → direction + trade plan + factor scores
//
//  Bridges indicatorEngine output to yahooScoringEngine input. Pure // @deprecated marker
//  function. Returns null when no actionable BUY/SELL setup is
//  detected (close not aligned with EMAs, RSI in dead zone, ATR
//  unavailable). The scanner treats null as `no_direction` and skips
//  scoring entirely.
//
//  Direction rules (latest bar):
//    BUY  : close > ema20 > ema50  AND  50 < rsi14 < 80
//    SELL : close < ema20 < ema50  AND  20 < rsi14 < 50
//
//  Trade plan (Wilder's ATR-based, fixed multiples):
//    BUY  stop = entry − 1.5×ATR    target1 = entry + 2.5×ATR    target2 = entry + 4.0×ATR
//    SELL stop = entry + 1.5×ATR    target1 = entry − 2.5×ATR    target2 = entry − 4.0×ATR
//    R:R fixed at 2.5/1.5 ≈ 1.667 → safely above the 1.5 hard floor.
//
//  Factor heuristics
//    trend       — EMA distance, sign-aware to direction
//    momentum    — RSI-band shape, peaks at 55–70 (BUY) / 30–45 (SELL)
//    volume      — today_volume / avgVolume20 ratio
//    breakout    — position in 20-bar range, sign-aware to direction
//    riskReward  — derived from the trade plan's actual R:R
//    liquidity   — log-scale on tradedValue20 (₹Cr)
//    stability   — inverse of ATR%, fallback to realised vol
// ════════════════════════════════════════════════════════════════

import type { IndicatorSnapshot } from './indicatorEngine';
import type { PreFilterMetrics } from './preFilterEngine';
import type { FactorScores } from './yahooScoringEngine'; // @deprecated marker

export type Direction = 'BUY' | 'SELL';

/**
 * Strategy code — matches Phase-6 spec (4 BUY strategies) plus
 * `bearish_breakdown` for the SELL path and `no_trade` for the
 * default-fallback case (returned as null from buildFactorBundle).
 *
 * Aligned with src/lib/signal-engine/types/signalEngine.types StrategyName
 * so the existing rejection engine accepts these labels without translation.
 */
export type ScannerStrategy =
  | 'bullish_breakout'        // close >= 20-day high, RSI ≤ 80, volume ≥ avg
  | 'bullish_pullback'        // uptrend (close > EMA50) + close near EMA20/EMA50
  | 'momentum_continuation'   // EMA20 > EMA50 + RSI 55-70 + close > EMA20, not extended
  | 'mean_reversion_bounce'   // RSI < 35 near support (close near low20)
  | 'bearish_breakdown';      // close < EMA20 < EMA50 + RSI 20-50

export interface TradePlan {
  entry:        number;
  stopLoss:     number;
  target1:      number;
  target2:      number;
  riskReward:   number;       // (|target1−entry|) / (|entry−stopLoss|)
  atrUsed:      number;
  stopAtrMult:  number;
  target1AtrMult: number;
}

export interface FactorBundle {
  direction:     Direction;
  factorScores:  FactorScores;
  tradePlan:     TradePlan;
  /** ratio of today_volume to avgVolume20 — surfaced for the scoring
   *  engine's gap-confirmation gate. */
  todayVolumeMult: number | null;
  /** liquidity score on the 0-100 axis (mirrors factorScores.liquidity)
   *  exposed under the rejection-engine's expected name. */
  liquidityScore: number;
  /** signal_type tag suitable for q365_signals.signal_type. */
  signalType: ScannerStrategy;
  /** strategy code matching src/lib/signal-engine/types/signalEngine.types StrategyName. */
  strategyName: ScannerStrategy;
  /** market_regime label for q365_signals.market_regime. */
  regimeLabel: string;
  /** ATR% (atr14 / close × 100) — kept for q365_signals provenance. */
  atrPct: number;
}

// ── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

interface StrategyMatch {
  direction: Direction;
  strategy:  ScannerStrategy;
}

/**
 * Detect which of the 5 scanner strategies the latest bar matches.
 * Priority order — first match wins (per Phase-6 spec).
 *
 * 1. Bullish Breakout       — close ≥ 20-day high, RSI ≤ 80
 * 2. Mean Reversion Bounce  — RSI < 35 near low20 (counter-trend buy at support)
 * 3. Bullish Pullback       — uptrend + close within 4% of EMA20/EMA50
 * 4. Momentum Continuation  — EMA20 > EMA50, RSI 55-72, close > EMA20, not over-extended
 * 5. Bearish Breakdown      — close < EMA20 < EMA50, RSI 20-50  (SELL path)
 *
 * Returns null when none of the five fit — the orchestrator records
 * this as `no_direction` (the spec's "No Trade" fallback).
 */
function detectStrategy(s: IndicatorSnapshot, todayVolMult: number | null): StrategyMatch | null {
  const c   = s.close;
  const e20 = s.ema20;
  const e50 = s.ema50;
  const rsi = s.rsi14;
  if (c == null || e20 == null || e50 == null || rsi == null) return null;

  const high20 = s.high20;
  const low20  = s.low20;

  // 1. Bullish Breakout — close at or above 20-day high.
  //    Reject if RSI > 80 (overbought) OR volume not at least normal.
  if (high20 != null && c >= high20 * 0.99 && rsi <= 80) {
    const volOk = todayVolMult == null ? true : todayVolMult >= 1.0;
    if (volOk) return { direction: 'BUY', strategy: 'bullish_breakout' };
  }

  // 2. Mean Reversion Bounce — RSI < 35 near 20-day low.
  //    Reject if support broken (close strictly below low20).
  if (low20 != null && rsi < 35 && c <= low20 * 1.05 && c > low20) {
    return { direction: 'BUY', strategy: 'mean_reversion_bounce' };
  }

  // 3. Bullish Pullback — uptrend + close near EMA20 / EMA50.
  //    Reject if close < EMA50 (uptrend lost).
  const inUptrend = e20 > e50 && c > e50;
  const nearEma20 = Math.abs((c - e20) / e20) <= 0.04;
  const nearEma50 = Math.abs((c - e50) / e50) <= 0.06;
  if (inUptrend && (nearEma20 || nearEma50) && rsi >= 40 && rsi <= 70) {
    return { direction: 'BUY', strategy: 'bullish_pullback' };
  }

  // 4. Momentum Continuation — EMA stack + healthy RSI + not over-extended.
  //    Reject if extended > 8% from EMA20.
  if (e20 > e50 && rsi >= 55 && rsi <= 72 && c > e20) {
    const distEma20Pct = ((c - e20) / e20) * 100;
    if (distEma20Pct <= 8) {
      return { direction: 'BUY', strategy: 'momentum_continuation' };
    }
  }

  // 5. Bearish Breakdown — bear stack with RSI in the 20-50 mid-zone.
  if (c < e20 && e20 < e50 && rsi < 50 && rsi > 20) {
    return { direction: 'SELL', strategy: 'bearish_breakdown' };
  }

  return null;  // No Trade — default fallback per spec
}

function buildTradePlan(close: number, atr: number, dir: Direction): TradePlan {
  const stopMult    = 1.5;
  const target1Mult = 2.5;
  const target2Mult = 4.0;

  const stopLoss = dir === 'BUY' ? close - stopMult    * atr : close + stopMult    * atr;
  const target1  = dir === 'BUY' ? close + target1Mult * atr : close - target1Mult * atr;
  const target2  = dir === 'BUY' ? close + target2Mult * atr : close - target2Mult * atr;

  const risk   = Math.abs(close - stopLoss);
  const reward = Math.abs(target1 - close);
  const rr = risk > 0 ? reward / risk : 0;

  return {
    entry:        close,
    stopLoss,
    target1,
    target2,
    riskReward:   rr,
    atrUsed:      atr,
    stopAtrMult:  stopMult,
    target1AtrMult: target1Mult,
  };
}

function trendScore(distEma20Pct: number, distEma50Pct: number, dir: Direction): number {
  // Sign-correct distances for the trade direction. For SELL, the
  // condition is ema20 > close AND ema50 > ema20, so distEma*Pct
  // values are negative — flip them.
  const d20 = dir === 'BUY' ? distEma20Pct : -distEma20Pct;
  const d50 = dir === 'BUY' ? distEma50Pct : -distEma50Pct;
  // Reward distance from EMAs but cap — far-extended trades are
  // late entries; penalise via the breakout/momentum factors too.
  const cd20 = clamp(d20, 0, 8);
  const cd50 = clamp(d50, 0, 12);
  return clamp(60 + cd20 * 2.5 + cd50 * 1.5, 0, 100);
}

function momentumScore(rsi: number, dir: Direction): number {
  if (dir === 'BUY') {
    if (rsi >= 55 && rsi <= 70) return 90;
    if (rsi >  70 && rsi <= 80) return clamp(70 - (rsi - 70) * 5,  0, 100);
    if (rsi >= 50 && rsi <  55) return clamp(60 + (rsi - 50) * 6,  0, 100);
    if (rsi >= 40 && rsi <  50) return clamp(30 + (rsi - 40) * 3,  0, 100);
    return 25;
  }
  // SELL
  if (rsi >= 30 && rsi <= 45) return 90;
  if (rsi >= 20 && rsi <  30) return clamp(70 - (30 - rsi) * 5,  0, 100);
  if (rsi >  45 && rsi <= 50) return clamp(60 + (50 - rsi) * 6,  0, 100);
  if (rsi >  50 && rsi <= 60) return clamp(30 + (60 - rsi) * 3,  0, 100);
  return 25;
}

function volumeScore(volMult: number): number {
  if (volMult >= 1.5) return clamp(85 + (volMult - 1.5) * 10, 0, 100);
  if (volMult >= 1.0) return clamp(60 + (volMult - 1.0) * 50, 0, 100);
  if (volMult >= 0.5) return clamp(40 + (volMult - 0.5) * 40, 0, 100);
  return clamp(20 + volMult * 40, 0, 100);
}

function breakoutScore(
  close: number, high20: number, low20: number, dir: Direction,
): number {
  if (dir === 'BUY') {
    if (close >= high20) return 95;
    const range = high20 - low20;
    if (range <= 0) return 50;
    const pos = (close - low20) / range;  // 0 at low, 1 at high
    return clamp(20 + pos * 70, 0, 95);
  }
  // SELL: closer to low20 = better
  if (close <= low20) return 95;
  const range = high20 - low20;
  if (range <= 0) return 50;
  const pos = (high20 - close) / range;
  return clamp(20 + pos * 70, 0, 95);
}

function riskRewardScore(rr: number): number {
  // Linear: RR=1.5 → 50, 2.0 → 63.5, 2.5 → 77, 3.0 → 90.5, 4.0+ → 100
  if (rr <= 1.5) return clamp(50 - (1.5 - rr) * 30, 0, 100);
  return clamp(50 + (rr - 1.5) * 27, 0, 100);
}

function liquidityScoreOf(tradedValue20: number | null): number {
  // Log-scale on traded value (INR). Pre-filter has already dropped
  // anything below ₹1 Cr, so we expect inputs ≥ 1e7.
  if (tradedValue20 == null || !Number.isFinite(tradedValue20) || tradedValue20 <= 0) return 30;
  if (tradedValue20 >= 1_000_00_00_000) return 95;  // ≥ ₹1000 Cr
  if (tradedValue20 >=   100_00_00_000) return 80;  // ≥  ₹100 Cr
  if (tradedValue20 >=    25_00_00_000) return 65;  // ≥   ₹25 Cr
  if (tradedValue20 >=    10_00_00_000) return 50;  // ≥   ₹10 Cr
  return 30;
}

function stabilityScore(s: IndicatorSnapshot): number {
  if (s.atr14 != null && s.close != null && s.close > 0) {
    const pct = (s.atr14 / s.close) * 100;
    if (pct < 2)  return 85;
    if (pct < 3)  return 70;
    if (pct < 5)  return 50;
    if (pct < 8)  return 30;
    return 15;
  }
  if (s.volatilityPct != null) {
    if (s.volatilityPct < 1.5) return 85;
    if (s.volatilityPct < 2.5) return 70;
    if (s.volatilityPct < 4)   return 50;
    return 30;
  }
  return 50;
}

function regimeLabelFor(s: IndicatorSnapshot, dir: Direction): string {
  // Lightweight regime classification from EMA stack. The signal
  // engine's regime detector is far richer; this is just enough to
  // populate q365_signals.market_regime so dashboards have a value.
  const c = s.close, e20 = s.ema20, e50 = s.ema50;
  if (c == null || e20 == null || e50 == null) return 'Neutral';
  if (dir === 'BUY')  return e20 > e50 * 1.03 ? 'Strong Bull' : 'Bullish';
  return e20 < e50 * 0.97 ? 'Strong Bear' : 'Bearish';
}

// ── Public entry ─────────────────────────────────────────────────

/**
 * Build a complete factor bundle for the latest bar. Returns null
 * when no clean BUY/SELL setup is present — the scanner treats null
 * as `no_direction` and skips scoring.
 */
export function buildFactorBundle(
  s:       IndicatorSnapshot,
  metrics: PreFilterMetrics,
): FactorBundle | null {
  if (s.close == null || s.atr14 == null || s.atr14 <= 0) return null;

  // Volume multiplier needs to be computed before strategy detection —
  // bullish_breakout's reject criterion ("weak volume") uses it.
  const todayVolumeMult =
    s.volume != null && metrics.avgVolume20 != null && metrics.avgVolume20 > 0
      ? s.volume / metrics.avgVolume20
      : null;

  const match = detectStrategy(s, todayVolumeMult);
  if (!match) return null;

  const direction = match.direction;
  const strategy  = match.strategy;
  const close     = s.close;
  const atr       = s.atr14;
  const tradePlan = buildTradePlan(close, atr, direction);

  const high20 = s.high20 ?? close;
  const low20  = s.low20  ?? close;

  const factorScores: FactorScores = {
    trend:      trendScore(s.distEma20Pct ?? 0, s.distEma50Pct ?? 0, direction),
    momentum:   momentumScore(s.rsi14 ?? 50, direction),
    volume:     volumeScore(todayVolumeMult ?? 0.5),
    breakout:   breakoutScore(close, high20, low20, direction),
    riskReward: riskRewardScore(tradePlan.riskReward),
    liquidity:  liquidityScoreOf(metrics.tradedValue20),
    stability:  stabilityScore(s),
  };

  const atrPct = (atr / close) * 100;

  return {
    direction,
    factorScores,
    tradePlan,
    todayVolumeMult,
    liquidityScore: factorScores.liquidity,
    signalType:     strategy,
    strategyName:   strategy,
    regimeLabel:    regimeLabelFor(s, direction),
    atrPct,
  };
}
