// ════════════════════════════════════════════════════════════════
//  Outcome Resolution — pure candle-walk evaluator
//
//  Rules (chronological):
//    1. Target 1 hit  (high >= target1)  → T1_HIT
//    2. Stop loss hit (low <= stop)      → SL_HIT
//    3. 15+ trading days, no hit       → EXPIRED
//    4. Otherwise                      → ACTIVE
//
//  Same-candle target + stop: SL_HIT (conservative).
// ════════════════════════════════════════════════════════════════

import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import type { SignalResolutionOutcome } from '../types/signalOutcomeLedger.types';
import { SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS } from '../types/signalOutcomeLedger.types';

export interface SignalForOutcomeResolution {
  signalId: number;
  symbol: string;
  strategyId: string;
  direction: string;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  createdAt: string;
}

export interface OutcomeResolutionResult {
  signalId: number;
  strategyId: string;
  symbol: string;
  outcome: SignalResolutionOutcome;
  outcomeAt: string;
  daysHeld: number;
  maxGainPct: number | null;
  candleCheckCount: number;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function candleDay(ts: string | Date): string {
  if (ts instanceof Date) {
    return Number.isFinite(ts.getTime()) ? ts.toISOString().slice(0, 10) : '';
  }
  const s = String(ts);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : s.slice(0, 10);
}

function toMysqlDatetime(ts: string | Date): string {
  if (ts instanceof Date) {
    return Number.isFinite(ts.getTime())
      ? ts.toISOString().slice(0, 19).replace('T', ' ')
      : new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function todayDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Candles from signal created_at through today (inclusive), ascending. */
export function filterCandlesForSignalWindow(
  candles: Candle[],
  createdAt: string,
  throughDay: string = todayDay(),
): Candle[] {
  const startDay = candleDay(createdAt);
  return candles
    .filter((c) => {
      const d = candleDay(c.ts);
      return d >= startDay && d <= throughDay;
    })
    .sort((a, b) => candleDay(a.ts).localeCompare(candleDay(b.ts)));
}

export function tradingDaysBetween(fromDay: string, toDay: string): number {
  const start = new Date(`${fromDay}T00:00:00Z`);
  const end = new Date(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  if (end < start) return 0;

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

export function evaluateOutcomeResolution(
  signal: SignalForOutcomeResolution,
  candles: Candle[],
  expireTradingDays: number = SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS,
  throughDay: string = todayDay(),
): OutcomeResolutionResult | null {
  const entry = num(signal.entryPrice);
  const stop = num(signal.stopLoss);
  const target = num(signal.target1);
  if (entry == null || entry <= 0 || stop == null || stop <= 0 || target == null || target <= 0) {
    return null;
  }

  const isSell = signal.direction.toUpperCase() === 'SELL';
  const windowCandles = filterCandlesForSignalWindow(candles, signal.createdAt, throughDay);

  let highestPrice = entry;
  let candleCheckCount = 0;
  let outcome: SignalResolutionOutcome = 'ACTIVE';
  let outcomeAt = toMysqlDatetime(signal.createdAt);
  let resolutionDay = candleDay(signal.createdAt);

  for (const c of windowCandles) {
    candleCheckCount++;
    const high = num(c.high) ?? 0;
    const low = num(c.low) ?? 0;

    if (high > highestPrice) highestPrice = high;

    const targetHit = isSell ? low <= target : high >= target;
    const stopHit = isSell ? high >= stop : low <= stop;

    if (targetHit && stopHit) {
      outcome = 'SL_HIT';
      outcomeAt = toMysqlDatetime(c.ts);
      resolutionDay = candleDay(c.ts);
      break;
    }
    if (stopHit) {
      outcome = 'SL_HIT';
      outcomeAt = toMysqlDatetime(c.ts);
      resolutionDay = candleDay(c.ts);
      break;
    }
    if (targetHit) {
      outcome = 'T1_HIT';
      outcomeAt = toMysqlDatetime(c.ts);
      resolutionDay = candleDay(c.ts);
      break;
    }

    outcomeAt = toMysqlDatetime(c.ts);
    resolutionDay = candleDay(c.ts);

    if (candleCheckCount >= expireTradingDays) {
      outcome = 'EXPIRED';
      break;
    }
  }

  const maxGainPct = round4(((highestPrice - entry) / entry) * 100);
  const daysHeld = Math.max(0, tradingDaysBetween(candleDay(signal.createdAt), resolutionDay));

  return {
    signalId: signal.signalId,
    strategyId: signal.strategyId,
    symbol: signal.symbol,
    outcome,
    outcomeAt,
    daysHeld,
    maxGainPct: candleCheckCount > 0 ? maxGainPct : null,
    candleCheckCount,
  };
}
