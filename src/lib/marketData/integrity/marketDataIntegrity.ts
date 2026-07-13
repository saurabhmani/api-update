// ════════════════════════════════════════════════════════════════
//  Market Data Integrity — validation utilities (Phase 1)
//
//  Pure functions. Reject corrupted candle/price inputs before they
//  reach feature build or signal generation. No IO.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';

export type IntegrityIssueCode =
  | 'MISSING_CANDLE'
  | 'DUPLICATE_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'NEGATIVE_PRICE'
  | 'ZERO_VOLUME'
  | 'INVALID_OHLC'
  | 'NON_MONOTONIC_TIMESTAMPS'
  | 'SPLIT_ANOMALY'
  | 'TIMEZONE_AMBIGUOUS';

export interface IntegrityIssue {
  code:    IntegrityIssueCode;
  index?:  number;
  message: string;
}

export interface CandleSeriesIntegrityResult {
  valid:   boolean;
  issues:  IntegrityIssue[];
  /** Deduped, ascending candles (copy) when valid or recoverable. */
  candles: Candle[];
}

export interface CandleIntegrityOptions {
  /** Reference "now" for future-timestamp checks (default: Date.now()). */
  nowMs?: number;
  /** Max allowed forward drift from nowMs (default: 24h). */
  maxFutureDriftMs?: number;
  /** Reject single-bar volume === 0 (default: false — zero vol is flagged not fatal). */
  rejectZeroVolume?: boolean;
  /** Flag split-like gaps between consecutive closes (default: true). */
  detectSplitAnomalies?: boolean;
  /** |close/prevClose - 1| above this triggers SPLIT_ANOMALY (default: 0.35). */
  splitJumpThreshold?: number;
}

const DEFAULT_OPTS: Required<CandleIntegrityOptions> = {
  nowMs:                Date.now(),
  maxFutureDriftMs:     24 * 60 * 60 * 1000,
  rejectZeroVolume:     false,
  detectSplitAnomalies: true,
  splitJumpThreshold:   0.35,
};

function parseTsMs(ts: string): number | null {
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isValidOhlc(c: Candle): boolean {
  return (
    Number.isFinite(c.open) && c.open > 0 &&
    Number.isFinite(c.high) && c.high > 0 &&
    Number.isFinite(c.low)  && c.low  > 0 &&
    Number.isFinite(c.close) && c.close > 0 &&
    c.high >= c.low &&
    c.high >= Math.min(c.open, c.close) &&
    c.low  <= Math.max(c.open, c.close) &&
    Number.isFinite(c.volume) && c.volume >= 0
  );
}

/**
 * Validate and normalize a daily candle series for signal-engine use.
 * Deduplicates by timestamp (keeps last occurrence), sorts ascending.
 */
export function validateCandleSeriesIntegrity(
  input: Candle[] | null | undefined,
  opts: CandleIntegrityOptions = {},
): CandleSeriesIntegrityResult {
  const o = { ...DEFAULT_OPTS, ...opts };
  const issues: IntegrityIssue[] = [];

  if (!input || input.length === 0) {
    return { valid: false, issues: [{ code: 'MISSING_CANDLE', message: 'Empty candle series' }], candles: [] };
  }

  // Dedupe by ts — last wins (warehouse replays)
  const byTs = new Map<string, Candle>();
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (!c?.ts) {
      issues.push({ code: 'MISSING_CANDLE', index: i, message: `Missing ts at index ${i}` });
      continue;
    }
    if (byTs.has(c.ts)) {
      issues.push({ code: 'DUPLICATE_TIMESTAMP', index: i, message: `Duplicate ts ${c.ts}` });
    }
    byTs.set(c.ts, { ...c });
  }

  const candles = [...byTs.values()].sort((a, b) => {
    const am = parseTsMs(a.ts) ?? 0;
    const bm = parseTsMs(b.ts) ?? 0;
    return am - bm;
  });

  let prevMs: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tsMs = parseTsMs(c.ts);
    if (tsMs == null) {
      issues.push({ code: 'TIMEZONE_AMBIGUOUS', index: i, message: `Unparseable ts: ${c.ts}` });
      continue;
    }
    if (tsMs > o.nowMs + o.maxFutureDriftMs) {
      issues.push({ code: 'FUTURE_TIMESTAMP', index: i, message: `Future ts ${c.ts}` });
    }
    if (prevMs != null && tsMs < prevMs) {
      issues.push({ code: 'NON_MONOTONIC_TIMESTAMPS', index: i, message: `Out of order at ${c.ts}` });
    }
    prevMs = tsMs;

    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
      issues.push({ code: 'NEGATIVE_PRICE', index: i, message: `Non-positive OHLC at ${c.ts}` });
    }
    if (!isValidOhlc(c)) {
      issues.push({ code: 'INVALID_OHLC', index: i, message: `Invalid OHLC relationship at ${c.ts}` });
    }
    if (c.volume === 0) {
      issues.push({ code: 'ZERO_VOLUME', index: i, message: `Zero volume at ${c.ts}` });
      if (o.rejectZeroVolume) {
        return { valid: false, issues, candles: [] };
      }
    }

    if (o.detectSplitAnomalies && i > 0) {
      const prev = candles[i - 1];
      if (prev.close > 0) {
        const jump = Math.abs(c.close / prev.close - 1);
        if (jump >= o.splitJumpThreshold) {
          issues.push({
            code: 'SPLIT_ANOMALY',
            index: i,
            message: `Close jump ${(jump * 100).toFixed(1)}% at ${c.ts} (possible split — verify adjustment)`,
          });
        }
      }
    }
  }

  const fatal = issues.some((x) =>
    x.code === 'MISSING_CANDLE' ||
    x.code === 'FUTURE_TIMESTAMP' ||
    x.code === 'INVALID_OHLC' ||
    x.code === 'NEGATIVE_PRICE' ||
    (x.code === 'ZERO_VOLUME' && o.rejectZeroVolume),
  );

  return {
    valid: !fatal,
    issues,
    candles: fatal ? [] : candles,
  };
}

export interface ResolvedPriceIntegrityInput {
  symbol: string;
  price:  number | null;
  ts:     number | string | null;
  quality?: string | null;
}

/**
 * Validate a resolver price envelope before signal-critical use.
 */
export function validateResolvedPriceIntegrity(
  input: ResolvedPriceIntegrityInput,
  opts: { nowMs?: number; maxFutureDriftMs?: number } = {},
): { valid: boolean; issues: IntegrityIssue[] } {
  const nowMs = opts.nowMs ?? Date.now();
  const maxFuture = opts.maxFutureDriftMs ?? 5 * 60 * 1000;
  const issues: IntegrityIssue[] = [];

  if (input.price == null || !Number.isFinite(input.price) || input.price <= 0) {
    issues.push({ code: 'NEGATIVE_PRICE', message: `${input.symbol}: invalid price ${input.price}` });
  }
  if (input.quality === 'LOW') {
    issues.push({ code: 'MISSING_CANDLE', message: `${input.symbol}: dataQuality LOW` });
  }
  if (input.ts != null) {
    const ms = typeof input.ts === 'number' ? input.ts : parseTsMs(String(input.ts));
    if (ms != null && ms > nowMs + maxFuture) {
      issues.push({ code: 'FUTURE_TIMESTAMP', message: `${input.symbol}: quote ts in future` });
    }
  }

  return { valid: issues.length === 0, issues };
}
