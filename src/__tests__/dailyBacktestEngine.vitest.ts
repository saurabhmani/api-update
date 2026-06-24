/**
 * dailyBacktestEngine — EOD warehouse alignment (Tests 1.1–1.2).
 */
import { describe, expect, it } from 'vitest';
import { intervalForBacktestWindow } from '@/lib/signals/dailyBacktestEngine';
import {
  evaluateSignalOutcome,
  type SignalForBacktest,
} from '@/lib/signals/dailyBacktestEngine';

describe('intervalForBacktestWindow — warehouse candle type', () => {
  it('1.1 — 1D window uses daily EOD bars (not 15minute intraday)', () => {
    expect(intervalForBacktestWindow('1D')).toBe('1day');
    expect(intervalForBacktestWindow('7D')).toBe('1day');
    expect(intervalForBacktestWindow('30D')).toBe('1day');
  });

  it('1.2 — INTRADAY prefers 5minute (route falls back to 1day when absent)', () => {
    expect(intervalForBacktestWindow('INTRADAY')).toBe('5minute');
  });
});

describe('evaluateSignalOutcome — calendar-day EOD filter', () => {
  const baseSignal = (): SignalForBacktest => ({
    symbol:        'RELIANCE',
    tradingsymbol: 'RELIANCE',
    direction:     'BUY',
    entry_price:   100,
    stop_loss:     95,
    target1:       110,
    generated_at:  '2026-06-23T09:30:00.000Z',
    __tier:        'APPROVED',
    __candles: [
      {
        ts:     '2026-06-23T00:00:00.000Z',
        open:   100,
        high:   112,
        low:    99,
        close:  108,
        volume: 1_000_000,
      },
    ],
  } as SignalForBacktest);

  it('includes same-session EOD bar for a 1D window (midnight ts before signal time)', () => {
    const result = evaluateSignalOutcome(baseSignal(), {
      reviewWindowLabel: '1D',
      windowEndIso:      '2026-06-23T23:59:59Z',
    });
    expect(result.outcome).not.toBe('INSUFFICIENT_DATA');
    expect(result.returnPercent).not.toBeNull();
  });
});
