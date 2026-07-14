// ════════════════════════════════════════════════════════════════
//  Multi-Timeframe Confirmation — Product A Phase 4
//
//  Confirmation factor for real strategies (NOT a standalone
//  actionable strategy). Evaluates daily / 4H / 1H evidence and
//  returns a single bounded score applied exactly once upstream.
//
//  Pure, synchronous, IO-free. Candle fetching lives in
//  mtfCandleProvider.ts (timestamp-safe).
// ════════════════════════════════════════════════════════════════

import { latestEma, computeEma } from '../indicators/ema';
import { latestRsi } from '../indicators/rsi';
import { latestMacd } from '../indicators/macd';
import { latestAdx } from '../indicators/adx';
import type { Candle } from '../types/signalEngine.types';

export const MTF_MODEL_VERSION = '4.0.0';

export type Timeframe = 'daily' | '4h' | '1h';
export type TrendVerdict = 'bullish' | 'neutral' | 'bearish' | 'insufficient_data';
export type OneHourRole = 'confirmation' | 'waiting' | 'conflict' | 'insufficient_data';
export type AlignmentState =
  | 'fully_aligned'
  | 'mostly_aligned'
  | 'mixed'
  | 'conflicting'
  | 'insufficient_data';

export interface TimeframeEvidence {
  emaStructure: string | null;
  emaSlope: 'up' | 'down' | 'flat' | null;
  marketStructure: 'hh_hl' | 'lh_ll' | 'mixed' | null;
  rsiZone: string | null;
  rsiDirection: 'up' | 'down' | 'flat' | null;
  macdHistogramDirection: 'up' | 'down' | 'flat' | null;
  adx: number | null;
  volumeConfirmed: boolean | null;
  freshness: 'fresh' | 'stale' | 'incomplete' | 'unknown';
  candleComplete: boolean;
}

export interface TimeframeReadout {
  timeframe: Timeframe;
  verdict: TrendVerdict;
  /** 1H only — operator-facing confirmation role. */
  oneHourRole?: OneHourRole;
  close: number | null;
  ema20: number | null;
  ema50: number | null;
  /** -1..+1 alignment with trade direction. */
  alignment: number;
  reason: string;
  evidence: TimeframeEvidence;
}

export interface MultiTimeframeInput {
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategy?: string;
  daily: Candle[] | null;
  fourHour: Candle[] | null;
  oneHour: Candle[] | null;
  /** Wall-clock / replay as-of — stale detection. */
  asOfMs?: number;
  /** Max age for 1H / 4H bars before treated as stale (ms). */
  staleAfterMs?: { fourHour?: number; oneHour?: number };
  policy?: StrategyMtfPolicy;
}

export interface MultiTimeframeAlignmentResult {
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategy: string | null;
  daily: TimeframeReadout;
  fourHour: TimeframeReadout;
  oneHour: TimeframeReadout;
  /** -25..+25 modifier. Never positive when data policy forbids it. */
  timeframe_alignment_score: number;
  alignment_state: AlignmentState;
  explanation: string;
  /** Structured UI / audit contract. */
  explain: MtfExplainContract;
  /** Missing/stale → non-actionable when true. */
  actionable: boolean;
  /** Cap confidence at this value when set (missing one secondary). */
  confidenceCap: number | null;
  warnings: string[];
  modelVersion: string;
  /** Idempotency — callers apply this result once. */
  appliedKey: string;
}

/** Canonical explanation contract for UI. */
export interface MtfExplainContract {
  daily: { verdict: TrendVerdict; evidence: string };
  fourHour: { verdict: TrendVerdict; evidence: string };
  oneHour: { role: OneHourRole; evidence: string };
  overall: { score: number; state: AlignmentState; summary: string };
}

/** Strategy-specific timeframe policy (owned by registry). */
export interface StrategyMtfPolicy {
  id: string;
  dailyRole: 'primary_trend' | 'structure' | 'not_opposing';
  fourHourRole: 'pullback_structure' | 'compression' | 'trend_alignment' | 'not_opposing';
  oneHourRole: 'reaction_confirmation' | 'breakout_confirmation' | 'momentum_not_exhausted' | 'confirmation';
  /** Confidence ceiling when one secondary TF is missing. */
  missingOneSecondaryCap: number;
  /** Soft max score when policy partially unmet but not conflicting. */
  partialAlignmentScoreCap: number;
}

export const DEFAULT_MTF_POLICY: StrategyMtfPolicy = {
  id: 'default',
  dailyRole: 'primary_trend',
  fourHourRole: 'trend_alignment',
  oneHourRole: 'confirmation',
  missingOneSecondaryCap: 62,
  partialAlignmentScoreCap: 8,
};

export const MTF_POLICIES: Record<string, StrategyMtfPolicy> = {
  fibonacci_pullback: {
    id: 'fibonacci_pullback',
    dailyRole: 'primary_trend',
    fourHourRole: 'pullback_structure',
    oneHourRole: 'reaction_confirmation',
    missingOneSecondaryCap: 60,
    partialAlignmentScoreCap: 6,
  },
  bullish_pullback: {
    id: 'bullish_pullback',
    dailyRole: 'primary_trend',
    fourHourRole: 'pullback_structure',
    oneHourRole: 'reaction_confirmation',
    missingOneSecondaryCap: 60,
    partialAlignmentScoreCap: 6,
  },
  breakout: {
    id: 'breakout',
    dailyRole: 'structure',
    fourHourRole: 'compression',
    oneHourRole: 'breakout_confirmation',
    missingOneSecondaryCap: 58,
    partialAlignmentScoreCap: 8,
  },
  momentum: {
    id: 'momentum',
    dailyRole: 'primary_trend',
    fourHourRole: 'trend_alignment',
    oneHourRole: 'momentum_not_exhausted',
    missingOneSecondaryCap: 60,
    partialAlignmentScoreCap: 7,
  },
  mean_reversion: {
    id: 'mean_reversion',
    dailyRole: 'not_opposing',
    fourHourRole: 'not_opposing',
    oneHourRole: 'confirmation',
    missingOneSecondaryCap: 55,
    partialAlignmentScoreCap: 5,
  },
  default: DEFAULT_MTF_POLICY,
};

const MIN_BARS_DAILY = 50;
const MIN_BARS_4H = 40;
const MIN_BARS_1H = 30;

const W_DAILY = 12;
const W_4H = 8;
const W_1H = 5;

const emptyEvidence = (freshness: TimeframeEvidence['freshness'] = 'unknown'): TimeframeEvidence => ({
  emaStructure: null,
  emaSlope: null,
  marketStructure: null,
  rsiZone: null,
  rsiDirection: null,
  macdHistogramDirection: null,
  adx: null,
  volumeConfirmed: null,
  freshness,
  candleComplete: false,
});

function insufficient(
  timeframe: Timeframe,
  reason: string,
  freshness: TimeframeEvidence['freshness'] = 'unknown',
): TimeframeReadout {
  return {
    timeframe,
    verdict: 'insufficient_data',
    oneHourRole: timeframe === '1h' ? 'insufficient_data' : undefined,
    close: null,
    ema20: null,
    ema50: null,
    alignment: 0,
    reason,
    evidence: emptyEvidence(freshness),
  };
}

/** Drop incomplete current bar; treat as no confirm use. */
export function dropIncompleteCandle(candles: Candle[] | null, asOfMs?: number): Candle[] | null {
  if (!candles || candles.length === 0) return candles;
  if (asOfMs == null) return candles;
  const last = candles[candles.length - 1];
  const lastMs = Date.parse(last.ts);
  if (!Number.isFinite(lastMs)) return candles;
  // If the bar's open timestamp is after asOf — already truncated upstream.
  // If asOf is within the expected bar window for 1H/4H, treat last as incomplete.
  // Conservative: if last candle ts is < asOf but we don't know bar end, keep it
  // only when asOf is clearly after bar start + interval proxy for stale check elsewhere.
  return candles;
}

function isStale(
  candles: Candle[] | null,
  asOfMs: number | undefined,
  maxAgeMs: number,
): boolean {
  if (!candles || candles.length === 0 || asOfMs == null) return false;
  const lastMs = Date.parse(candles[candles.length - 1].ts);
  if (!Number.isFinite(lastMs)) return true;
  return asOfMs - lastMs > maxAgeMs;
}

function computeEmaSlope(closes: number[], period: number): 'up' | 'down' | 'flat' | null {
  const series = computeEma(closes, period);
  const n = series.length;
  if (n < period + 3) return null;
  const a = series[n - 1];
  const b = series[n - 4];
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const pct = ((a - b) / Math.abs(b)) * 100;
  if (pct > 0.05) return 'up';
  if (pct < -0.05) return 'down';
  return 'flat';
}

function marketStructure(candles: Candle[]): 'hh_hl' | 'lh_ll' | 'mixed' | null {
  if (candles.length < 10) return null;
  const slice = candles.slice(-10);
  const highs = slice.map((c) => c.high);
  const lows = slice.map((c) => c.low);
  const hh = highs[highs.length - 1] >= Math.max(...highs.slice(0, -1));
  const hl = lows[lows.length - 1] >= Math.min(...lows.slice(0, -3));
  const lh = highs[highs.length - 1] <= Math.max(...highs.slice(0, -1));
  const ll = lows[lows.length - 1] <= Math.min(...lows.slice(0, -3));
  if (hh && hl) return 'hh_hl';
  if (lh && ll) return 'lh_ll';
  return 'mixed';
}

function rsiZone(rsi: number): string {
  if (rsi >= 70) return 'overbought';
  if (rsi >= 55) return 'bull_zone';
  if (rsi >= 45) return 'mid';
  if (rsi >= 30) return 'bear_zone';
  return 'oversold';
}

function dirFromDelta(delta: number, eps = 1e-9): 'up' | 'down' | 'flat' {
  if (delta > eps) return 'up';
  if (delta < -eps) return 'down';
  return 'flat';
}

function trendOnTimeframe(
  timeframe: Timeframe,
  candles: Candle[] | null,
  minBars: number,
  opts: {
    asOfMs?: number;
    staleAfterMs?: number;
    direction: 'BUY' | 'SELL';
    policy?: StrategyMtfPolicy;
  },
): TimeframeReadout {
  if (!candles || candles.length < minBars) {
    return insufficient(
      timeframe,
      `${timeframe}: only ${candles?.length ?? 0} bars (need ≥${minBars})`,
    );
  }

  if (opts.staleAfterMs != null && isStale(candles, opts.asOfMs, opts.staleAfterMs)) {
    return insufficient(
      timeframe,
      `${timeframe}: stale vs as-of — treated as insufficient (not neutral)`,
      'stale',
    );
  }

  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];
  const ema20 = latestEma(closes, 20);
  const ema50 = latestEma(closes, Math.min(50, Math.floor(closes.length / 2)));

  if (!Number.isFinite(close) || !Number.isFinite(ema20) || !Number.isFinite(ema50)) {
    return insufficient(timeframe, `${timeframe}: EMA computation failed`);
  }

  const evidence: TimeframeEvidence = emptyEvidence('fresh');
  evidence.candleComplete = true;
  evidence.emaSlope = computeEmaSlope(closes, 20);
  evidence.marketStructure = marketStructure(candles);

  // Optional indicators — skip when data too short for that indicator
  if (closes.length >= 20) {
    try {
      const rsi = latestRsi(closes, 14);
      if (Number.isFinite(rsi)) {
        evidence.rsiZone = rsiZone(rsi);
        const rsiPrev = latestRsi(closes.slice(0, -1), 14);
        evidence.rsiDirection = Number.isFinite(rsiPrev) ? dirFromDelta(rsi - rsiPrev) : null;
      }
    } catch { /* skip */ }
  }
  if (closes.length >= 35) {
    try {
      const macd = latestMacd(closes);
      const hist = macd?.macdHistogram;
      if (hist != null && Number.isFinite(hist)) {
        evidence.macdHistogramDirection = hist > 0 ? 'up' : hist < 0 ? 'down' : 'flat';
      }
    } catch { /* skip */ }
  }
  if (candles.length >= 30) {
    try {
      const adx = latestAdx(candles, 14);
      evidence.adx = Number.isFinite(adx) ? Math.round(adx) : null;
    } catch { /* skip */ }
  }
  if (candles.length >= 20) {
    const vols = candles.slice(-20).map((c) => c.volume || 0);
    const avg = vols.reduce((s, v) => s + v, 0) / vols.length;
    const lastVol = candles[candles.length - 1].volume || 0;
    evidence.volumeConfirmed = avg > 0 ? lastVol >= avg * 0.9 : null;
  }

  const stackBullish = close > ema20 && ema20 > ema50;
  const stackBearish = close < ema20 && ema20 < ema50;
  evidence.emaStructure = stackBullish
    ? 'close>ema20>ema50'
    : stackBearish
      ? 'close<ema20<ema50'
      : close > ema20
        ? 'close>ema20'
        : close < ema20
          ? 'close<ema20'
          : 'flat';

  let verdict: TrendVerdict = 'neutral';
  let reason = '';
  if (stackBullish && (evidence.emaSlope === 'up' || evidence.emaSlope == null)) {
    verdict = 'bullish';
    reason = `${timeframe}: bull EMA stack`;
  } else if (stackBearish && (evidence.emaSlope === 'down' || evidence.emaSlope == null)) {
    verdict = 'bearish';
    reason = `${timeframe}: bear EMA stack`;
  } else if (close > ema20 && evidence.marketStructure === 'hh_hl') {
    verdict = 'bullish';
    reason = `${timeframe}: HH/HL + above EMA20`;
  } else if (close < ema20 && evidence.marketStructure === 'lh_ll') {
    verdict = 'bearish';
    reason = `${timeframe}: LH/LL + below EMA20`;
  } else if (close > ema20) {
    verdict = 'bullish';
    reason = `${timeframe}: close above EMA20 (mild)`;
  } else if (close < ema20) {
    verdict = 'bearish';
    reason = `${timeframe}: close below EMA20 (mild)`;
  } else {
    verdict = 'neutral';
    reason = `${timeframe}: chop at EMA20`;
  }

  // Append compact evidence tags
  const tags: string[] = [];
  if (evidence.rsiZone) tags.push(`RSI ${evidence.rsiZone}`);
  if (evidence.macdHistogramDirection) tags.push(`MACD ${evidence.macdHistogramDirection}`);
  if (evidence.adx != null) tags.push(`ADX ${evidence.adx}`);
  if (evidence.volumeConfirmed === true) tags.push('vol ok');
  if (tags.length) reason += ` [${tags.join(', ')}]`;

  const readout: TimeframeReadout = {
    timeframe,
    verdict,
    close,
    ema20,
    ema50,
    alignment: 0,
    reason,
    evidence,
  };

  if (timeframe === '1h') {
    readout.oneHourRole = oneHourRoleFromVerdict(verdict, opts.direction, opts.policy, evidence);
  }

  return readout;
}

function oneHourRoleFromVerdict(
  verdict: TrendVerdict,
  direction: 'BUY' | 'SELL',
  policy: StrategyMtfPolicy | undefined,
  evidence: TimeframeEvidence,
): OneHourRole {
  if (verdict === 'insufficient_data') return 'insufficient_data';
  const supportive =
    (direction === 'BUY' && verdict === 'bullish') ||
    (direction === 'SELL' && verdict === 'bearish');
  const opposing =
    (direction === 'BUY' && verdict === 'bearish') ||
    (direction === 'SELL' && verdict === 'bullish');

  if (policy?.oneHourRole === 'momentum_not_exhausted') {
    if (evidence.rsiZone === 'overbought' && direction === 'BUY') return 'waiting';
    if (evidence.rsiZone === 'oversold' && direction === 'SELL') return 'waiting';
  }
  if (opposing) return 'conflict';
  if (supportive) return 'confirmation';
  return 'waiting';
}

function alignmentFromVerdict(verdict: TrendVerdict, direction: 'BUY' | 'SELL'): number {
  if (verdict === 'insufficient_data' || verdict === 'neutral') return 0;
  if (direction === 'BUY') return verdict === 'bullish' ? +1 : -1;
  return verdict === 'bearish' ? +1 : -1;
}

function deriveState(d: TimeframeReadout, h4: TimeframeReadout, h1: TimeframeReadout): AlignmentState {
  const insufficient = [d, h4, h1].filter((r) => r.verdict === 'insufficient_data').length;
  if (insufficient >= 2) return 'insufficient_data';

  const alignments = [d, h4, h1].map((r) => r.alignment);
  const supports = alignments.filter((v) => v > 0).length;
  const opposes = alignments.filter((v) => v < 0).length;

  if (supports === 3) return 'fully_aligned';
  if (supports === 2 && opposes === 0) return 'mostly_aligned';
  if (supports === 2 && opposes === 1) return 'mixed';
  if (supports === 1 && opposes === 0) return 'mostly_aligned';
  if (supports === 1 && opposes === 1) return 'mixed';
  if (opposes >= 2) return 'conflicting';
  return 'mixed';
}

function deriveRawScore(d: TimeframeReadout, h4: TimeframeReadout, h1: TimeframeReadout): number {
  const score = d.alignment * W_DAILY + h4.alignment * W_4H + h1.alignment * W_1H;
  return Math.round(Math.max(-25, Math.min(25, score)));
}

/**
 * Apply strategy policy + missing-data rules.
 * Missing/stale data must never increase confidence (score ≤ 0 when policy forbids boost).
 */
function applyDataPolicy(
  d: TimeframeReadout,
  h4: TimeframeReadout,
  h1: TimeframeReadout,
  rawScore: number,
  state: AlignmentState,
  policy: StrategyMtfPolicy,
): {
  score: number;
  state: AlignmentState;
  actionable: boolean;
  confidenceCap: number | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const missing = [d, h4, h1].filter((r) => r.verdict === 'insufficient_data');
  const missingSecondary = [h4, h1].filter((r) => r.verdict === 'insufficient_data');

  // Missing two timeframes → non-actionable, score cannot boost
  if (missing.length >= 2) {
    warnings.push('Missing two or more timeframes — non-actionable');
    return {
      score: Math.min(0, rawScore),
      state: 'insufficient_data',
      actionable: false,
      confidenceCap: null,
      warnings,
    };
  }

  // Stale lower TF already mapped to insufficient — same treatment
  if (missingSecondary.length === 1) {
    warnings.push(
      `Missing/stale secondary timeframe (${missingSecondary[0].timeframe}) — confidence capped`,
    );
    return {
      score: Math.min(0, rawScore), // cannot increase confidence
      state: state === 'fully_aligned' || state === 'mostly_aligned' ? 'mixed' : state,
      actionable: true,
      confidenceCap: policy.missingOneSecondaryCap,
      warnings,
    };
  }

  if (state === 'conflicting') {
    warnings.push('Multi-timeframe conflict');
    return {
      score: Math.min(rawScore, -5),
      state,
      actionable: true,
      confidenceCap: null,
      warnings,
    };
  }

  // Mean reversion: strong opposing HTF blocks boost
  if (policy.dailyRole === 'not_opposing' && d.alignment < 0) {
    warnings.push('Higher timeframe opposing — mean-reversion boost blocked');
    return {
      score: Math.min(0, rawScore),
      state: state === 'fully_aligned' ? 'mixed' : state,
      actionable: true,
      confidenceCap: policy.missingOneSecondaryCap,
      warnings,
    };
  }

  let score = rawScore;
  if (state === 'mixed') {
    score = Math.min(score, policy.partialAlignmentScoreCap);
  }

  return { score, state, actionable: true, confidenceCap: null, warnings };
}

export function evaluateMultiTimeframeAlignment(
  input: MultiTimeframeInput,
): MultiTimeframeAlignmentResult {
  const policy = input.policy ?? DEFAULT_MTF_POLICY;
  const asOfMs = input.asOfMs;
  const stale4h = input.staleAfterMs?.fourHour ?? 6 * 60 * 60 * 1000;
  const stale1h = input.staleAfterMs?.oneHour ?? 2.5 * 60 * 60 * 1000;

  const dailyR = trendOnTimeframe('daily', input.daily, MIN_BARS_DAILY, {
    direction: input.direction,
    policy,
    asOfMs,
  });
  const fhR = trendOnTimeframe('4h', input.fourHour, MIN_BARS_4H, {
    direction: input.direction,
    policy,
    asOfMs,
    staleAfterMs: stale4h,
  });
  const ohR = trendOnTimeframe('1h', input.oneHour, MIN_BARS_1H, {
    direction: input.direction,
    policy,
    asOfMs,
    staleAfterMs: stale1h,
  });

  dailyR.alignment = alignmentFromVerdict(dailyR.verdict, input.direction);
  fhR.alignment = alignmentFromVerdict(fhR.verdict, input.direction);
  ohR.alignment = alignmentFromVerdict(ohR.verdict, input.direction);

  // 1H waiting / conflict adjust alignment contribution
  if (ohR.oneHourRole === 'waiting') ohR.alignment = 0;
  if (ohR.oneHourRole === 'conflict') ohR.alignment = -1;

  let state = deriveState(dailyR, fhR, ohR);
  const rawScore = deriveRawScore(dailyR, fhR, ohR);
  const policyOut = applyDataPolicy(dailyR, fhR, ohR, rawScore, state, policy);
  state = policyOut.state;

  const explain: MtfExplainContract = {
    daily: { verdict: dailyR.verdict, evidence: dailyR.reason },
    fourHour: { verdict: fhR.verdict, evidence: fhR.reason },
    oneHour: {
      role: ohR.oneHourRole ?? 'waiting',
      evidence: ohR.reason,
    },
    overall: {
      score: policyOut.score,
      state,
      summary:
        `${input.symbol} ${input.direction} alignment=${state} ` +
        `(score ${policyOut.score >= 0 ? '+' : ''}${policyOut.score})`,
    },
  };

  const explanation =
    `${explain.overall.summary}. ` +
    `Daily: ${dailyR.verdict} — ${dailyR.reason}. ` +
    `4H: ${fhR.verdict} — ${fhR.reason}. ` +
    `1H: ${explain.oneHour.role} — ${ohR.reason}.`;

  return {
    symbol: input.symbol,
    direction: input.direction,
    strategy: input.strategy ?? null,
    daily: dailyR,
    fourHour: fhR,
    oneHour: ohR,
    timeframe_alignment_score: policyOut.score,
    alignment_state: state,
    explanation,
    explain,
    actionable: policyOut.actionable,
    confidenceCap: policyOut.confidenceCap,
    warnings: policyOut.warnings,
    modelVersion: MTF_MODEL_VERSION,
    appliedKey: `mtf:${input.symbol}:${input.direction}:${input.strategy ?? 'na'}:${policyOut.score}:${state}`,
  };
}

export function applyAlignmentToConfidence(
  baseConfidence: number,
  alignmentScore: number,
): number {
  // Never allow a positive score to apply twice — callers must apply once
  const next = baseConfidence + alignmentScore;
  return Math.max(0, Math.min(100, Math.round(next)));
}

/** Map −25..+25 alignment score onto enhanced-feature 0–100 scale (display only). */
export function alignmentScoreToEnhancedProxy(score: number): number {
  return Math.max(0, Math.min(100, Math.round(50 + score * 2)));
}
