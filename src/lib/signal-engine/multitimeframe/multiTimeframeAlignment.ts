// ════════════════════════════════════════════════════════════════
//  Multi-Timeframe Confirmation — Phase NEXT
//
//  Cross-timeframe alignment scorer. Looks at the daily trend, the
//  4H trend, and the 1H momentum and decides whether the candidate
//  trade is supported by the higher timeframes (boost) or fighting
//  them (penalty).
//
//  Trend extraction is intentionally minimal — we use price-vs-EMA
//  and EMA stack rather than re-running every Phase-1 indicator.
//  Higher-timeframe candle providers feed in their own EMAs already
//  (or we compute EMAs locally from candle arrays).
//
//  Alignment states:
//    fully_aligned     all three timeframes confirm direction
//    mostly_aligned    two of three confirm
//    mixed             one confirms, one neutral, one against
//    conflicting       majority opposes the trade direction
//    insufficient_data not enough candles on one or more timeframes
//
//  Returns:
//    timeframe_alignment_score   -25..+25 modifier (centered at 0)
//    alignment_state             one of the five states above
//
//  Pure, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import { latestEma } from '../indicators/ema';
import type { Candle } from '../types/signalEngine.types';

// ── Inputs / Outputs ────────────────────────────────────────────

export type Timeframe = 'daily' | '4h' | '1h';
export type TrendVerdict = 'bullish' | 'neutral' | 'bearish' | 'insufficient_data';
export type AlignmentState =
  | 'fully_aligned'
  | 'mostly_aligned'
  | 'mixed'
  | 'conflicting'
  | 'insufficient_data';

export interface TimeframeReadout {
  timeframe:    Timeframe;
  verdict:      TrendVerdict;
  /** Most recent close on this timeframe. */
  close:        number | null;
  ema20:        number | null;
  ema50:        number | null;
  /** -1..+1 alignment with trade direction. +1 = supportive, 0 = neutral. */
  alignment:    number;
  reason:       string;
}

export interface MultiTimeframeInput {
  symbol:    string;
  direction: 'BUY' | 'SELL';
  /** Daily candles, oldest → newest. ≥50 bars recommended. */
  daily:     Candle[] | null;
  /** 4H candles, oldest → newest. ≥50 bars recommended. */
  fourHour:  Candle[] | null;
  /** 1H candles, oldest → newest. ≥30 bars recommended. */
  oneHour:   Candle[] | null;
}

export interface MultiTimeframeAlignmentResult {
  symbol:                       string;
  direction:                    'BUY' | 'SELL';
  daily:                        TimeframeReadout;
  fourHour:                     TimeframeReadout;
  oneHour:                      TimeframeReadout;
  /** -25..+25 modifier. Positive = boost, negative = penalty. */
  timeframe_alignment_score:    number;
  alignment_state:              AlignmentState;
  /** Human-readable summary of the verdict. */
  explanation:                  string;
}

// ── Trend extraction ────────────────────────────────────────────

const MIN_BARS_DAILY = 50;
const MIN_BARS_4H    = 50;
const MIN_BARS_1H    = 30;

function trendOnTimeframe(
  timeframe: Timeframe,
  candles:   Candle[] | null,
  minBars:   number,
): TimeframeReadout {
  if (!candles || candles.length < minBars) {
    return {
      timeframe,
      verdict:   'insufficient_data',
      close:     null,
      ema20:     null,
      ema50:     null,
      alignment: 0,
      reason:    `${timeframe}: only ${candles?.length ?? 0} bars (need ≥${minBars})`,
    };
  }
  const closes = candles.map((c) => c.close);
  const close  = closes[closes.length - 1];
  const ema20  = latestEma(closes, 20);
  const ema50  = latestEma(closes, 50);

  if (!Number.isFinite(close) || !Number.isFinite(ema20) || !Number.isFinite(ema50)) {
    return {
      timeframe,
      verdict:   'insufficient_data',
      close:     Number.isFinite(close) ? close : null,
      ema20:     Number.isFinite(ema20) ? ema20 : null,
      ema50:     Number.isFinite(ema50) ? ema50 : null,
      alignment: 0,
      reason:    `${timeframe}: EMA computation failed`,
    };
  }

  const stackBullish = close > ema20 && ema20 > ema50;
  const stackBearish = close < ema20 && ema20 < ema50;
  const aboveEma20   = close > ema20;
  const belowEma20   = close < ema20;

  let verdict: TrendVerdict = 'neutral';
  let reason  = '';
  if (stackBullish) {
    verdict = 'bullish';
    reason  = `${timeframe}: close>EMA20>EMA50 (bull stack)`;
  } else if (stackBearish) {
    verdict = 'bearish';
    reason  = `${timeframe}: close<EMA20<EMA50 (bear stack)`;
  } else if (aboveEma20) {
    verdict = 'bullish';
    reason  = `${timeframe}: close above EMA20 (mild bull)`;
  } else if (belowEma20) {
    verdict = 'bearish';
    reason  = `${timeframe}: close below EMA20 (mild bear)`;
  } else {
    verdict = 'neutral';
    reason  = `${timeframe}: close at EMA20 (chop)`;
  }

  return { timeframe, verdict, close, ema20, ema50, alignment: 0, reason };
}

function alignmentFromVerdict(
  verdict:   TrendVerdict,
  direction: 'BUY' | 'SELL',
): number {
  if (verdict === 'insufficient_data') return 0;
  if (verdict === 'neutral')           return 0;
  if (direction === 'BUY')  return verdict === 'bullish' ? +1 : -1;
  /* SELL */                 return verdict === 'bearish' ? +1 : -1;
}

// ── State + score derivation ────────────────────────────────────

function deriveState(
  d: TimeframeReadout,
  h4: TimeframeReadout,
  h1: TimeframeReadout,
): AlignmentState {
  const verdicts = [d, h4, h1].map((r) => r.alignment);
  const insufficient = [d, h4, h1].filter((r) => r.verdict === 'insufficient_data').length;
  if (insufficient >= 2) return 'insufficient_data';

  const supports = verdicts.filter((v) => v > 0).length;
  const opposes  = verdicts.filter((v) => v < 0).length;

  if (supports === 3)                 return 'fully_aligned';
  if (supports === 2 && opposes === 0) return 'mostly_aligned';
  if (supports === 2 && opposes === 1) return 'mixed';
  if (supports === 1 && opposes === 0) return 'mostly_aligned';
  if (supports === 1 && opposes === 1) return 'mixed';
  if (opposes >= 2)                   return 'conflicting';
  return 'mixed';
}

/** Score is bounded to the spec's −25..+25 modifier window. The
 *  daily timeframe has the biggest weight (12), then 4H (8), then
 *  1H (5), reflecting the operator's institutional bias toward
 *  higher-timeframe confirmation. */
const W_DAILY = 12;
const W_4H    = 8;
const W_1H    = 5;

function deriveScore(
  d: TimeframeReadout,
  h4: TimeframeReadout,
  h1: TimeframeReadout,
): number {
  const score = d.alignment * W_DAILY + h4.alignment * W_4H + h1.alignment * W_1H;
  return Math.round(Math.max(-25, Math.min(25, score)));
}

// ── Public API ──────────────────────────────────────────────────

export function evaluateMultiTimeframeAlignment(
  input: MultiTimeframeInput,
): MultiTimeframeAlignmentResult {
  const dailyR = trendOnTimeframe('daily', input.daily,    MIN_BARS_DAILY);
  const fhR    = trendOnTimeframe('4h',    input.fourHour, MIN_BARS_4H);
  const ohR    = trendOnTimeframe('1h',    input.oneHour,  MIN_BARS_1H);

  dailyR.alignment = alignmentFromVerdict(dailyR.verdict, input.direction);
  fhR.alignment    = alignmentFromVerdict(fhR.verdict,    input.direction);
  ohR.alignment    = alignmentFromVerdict(ohR.verdict,    input.direction);

  const state = deriveState(dailyR, fhR, ohR);
  const score = deriveScore(dailyR, fhR, ohR);

  const explanation =
    `${input.symbol} ${input.direction} alignment=${state} (score ${score >= 0 ? '+' : ''}${score}). ` +
    `${dailyR.reason}. ${fhR.reason}. ${ohR.reason}.`;

  return {
    symbol:                    input.symbol,
    direction:                 input.direction,
    daily:                     dailyR,
    fourHour:                  fhR,
    oneHour:                   ohR,
    timeframe_alignment_score: score,
    alignment_state:           state,
    explanation,
  };
}

// ── Score boost / penalty helper ─────────────────────────────────

/**
 * Apply the alignment score as a confidence modifier, clamping the
 * resulting confidence to [0, 100]. Callers that want a softer apply
 * can scale the modifier before passing it in.
 */
export function applyAlignmentToConfidence(
  baseConfidence: number,
  alignmentScore: number,
): number {
  const next = baseConfidence + alignmentScore;
  return Math.max(0, Math.min(100, Math.round(next)));
}
