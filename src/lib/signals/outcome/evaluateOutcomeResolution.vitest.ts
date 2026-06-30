import { describe, expect, it } from 'vitest';
import {
  evaluateOutcomeResolution,
  filterCandlesForSignalWindow,
  tradingDaysBetween,
  type SignalForOutcomeResolution,
} from '@/lib/signals/outcome/evaluateOutcomeResolution';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import { SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS } from '@/lib/signals/types/signalOutcomeLedger.types';

const THROUGH_DAY = '2026-02-28';

const baseSignal: SignalForOutcomeResolution = {
  signalId: 42,
  symbol: 'RELIANCE',
  strategyId: 'bullish_breakout',
  direction: 'BUY',
  entryPrice: 100,
  stopLoss: 95,
  target1: 110,
  createdAt: '2026-01-02 10:00:00',
};

function bar(day: string, o: number, h: number, l: number, c: number): Candle {
  return { ts: `${day} 00:00:00`, open: o, high: h, low: l, close: c, volume: 1_000_000 };
}

function weekdayBars(count: number, startDay = '2026-01-03'): Candle[] {
  const out: Candle[] = [];
  let d = new Date(`${startDay}T00:00:00Z`);
  while (out.length < count) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      out.push(bar(d.toISOString().slice(0, 10), 100, 101, 99, 100));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function evalSignal(candles: Candle[]) {
  return evaluateOutcomeResolution(baseSignal, candles, SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS, THROUGH_DAY)!;
}

function runTwice(candles: Candle[]) {
  const first = evalSignal(candles);
  const second = evalSignal(candles);
  return { first, second };
}

describe('Outcome Resolution Engine', () => {
  describe('Target Hit (T1_HIT)', () => {
    it('high >= target1 → T1_HIT', () => {
      const r = evalSignal([bar('2026-01-03', 100, 112, 99, 111)]);
      expect(r.outcome).toBe('T1_HIT');
      expect(r.candleCheckCount).toBe(1);
      expect(r.outcomeAt.slice(0, 10)).toBe('2026-01-03');
    });

    it('target hit on later candle after quiet days', () => {
      const r = evalSignal([
        bar('2026-01-03', 100, 101, 99, 100),
        bar('2026-01-06', 100, 112, 99, 111),
      ]);
      expect(r.outcome).toBe('T1_HIT');
      expect(r.candleCheckCount).toBe(2);
    });
  });

  describe('Stop Loss (SL_HIT)', () => {
    it('low <= stop → SL_HIT', () => {
      const r = evalSignal([bar('2026-01-03', 100, 101, 94, 95)]);
      expect(r.outcome).toBe('SL_HIT');
      expect(r.candleCheckCount).toBe(1);
    });

    it('stop on day 3', () => {
      const r = evalSignal([
        bar('2026-01-03', 100, 101, 99, 100),
        bar('2026-01-06', 100, 101, 99, 100),
        bar('2026-01-07', 100, 101, 94, 95),
      ]);
      expect(r.outcome).toBe('SL_HIT');
      expect(r.candleCheckCount).toBe(3);
    });
  });

  describe('Expired', () => {
    it(`${SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS} trading days without hit → EXPIRED`, () => {
      const r = evalSignal(weekdayBars(SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS));
      expect(r.outcome).toBe('EXPIRED');
      expect(r.candleCheckCount).toBeGreaterThanOrEqual(14);
      expect(r.daysHeld).toBeGreaterThanOrEqual(SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS);
    });

    it('expires by trading-day count even when candle gaps exist', () => {
      const gaps = [
        bar('2026-01-05', 100, 101, 99, 100),
        bar('2026-01-12', 100, 101, 99, 100),
        bar('2026-01-19', 100, 101, 99, 100),
        bar('2026-01-22', 100, 101, 99, 100),
      ];
      const r = evaluateOutcomeResolution(
        baseSignal,
        gaps,
        4,
        '2026-02-28',
      )!;
      expect(r.outcome).toBe('EXPIRED');
    });
  });

  describe('Active', () => {
    it('few candles inside window → ACTIVE', () => {
      const r = evalSignal([
        bar('2026-01-03', 100, 101, 99, 100),
        bar('2026-01-06', 100, 101, 99, 100),
      ]);
      expect(r.outcome).toBe('ACTIVE');
      expect(r.candleCheckCount).toBe(2);
    });

    it('no candles in window → ACTIVE with zero checks', () => {
      const r = evalSignal([bar('2026-01-01', 100, 101, 99, 100)]);
      expect(r.outcome).toBe('ACTIVE');
      expect(r.candleCheckCount).toBe(0);
      expect(r.maxGainPct).toBeNull();
    });
  });

  describe('Same candle Target + Stop Loss (gap)', () => {
    it('both levels touched → SL_HIT (conservative)', () => {
      const r = evalSignal([bar('2026-01-03', 100, 115, 94, 100)]);
      expect(r.outcome).toBe('SL_HIT');
    });
  });

  describe('max_gain_pct', () => {
    it('((highest_price - entry) / entry) × 100', () => {
      const r = evalSignal([
        bar('2026-01-03', 100, 108, 99, 105),
        bar('2026-01-06', 100, 105, 99, 102),
      ]);
      expect(r.maxGainPct).toBe(8);
    });

    it('SELL uses lowest price for favorable move', () => {
      const sellSignal = { ...baseSignal, direction: 'SELL', target1: 90, stopLoss: 105 };
      const candles = [
        bar('2026-01-03', 100, 101, 95, 96),
        bar('2026-01-06', 96, 97, 92, 93),
      ];
      const r = evaluateOutcomeResolution(
        sellSignal,
        candles,
        SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS,
        THROUGH_DAY,
      )!;
      expect(r.maxGainPct).toBe(8);
    });
  });

  describe('Multiple executions (idempotency)', () => {
    it('T1_HIT — identical across runs', () => {
      const candles = [bar('2026-01-03', 100, 112, 99, 111)];
      expect(runTwice(candles).second).toEqual(runTwice(candles).first);
    });

    it('SL_HIT — identical across runs', () => {
      const candles = [bar('2026-01-03', 100, 101, 94, 95)];
      expect(runTwice(candles).second).toEqual(runTwice(candles).first);
    });

    it('ACTIVE — identical across runs', () => {
      expect(runTwice(weekdayBars(5)).second).toEqual(runTwice(weekdayBars(5)).first);
    });

    it('EXPIRED — identical across runs', () => {
      expect(runTwice(weekdayBars(SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS + 1)).second)
        .toEqual(runTwice(weekdayBars(SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS + 1)).first);
    });

    it('gap scenario — identical across 5 runs', () => {
      const candles = [bar('2026-01-03', 100, 115, 94, 100)];
      const baseline = evalSignal(candles);
      for (let i = 0; i < 5; i++) {
        expect(evalSignal(candles)).toEqual(baseline);
      }
    });
  });
});

describe('filterCandlesForSignalWindow', () => {
  it('includes created_at through today', () => {
    const candles = [
      bar('2026-01-01', 100, 101, 99, 100),
      bar('2026-01-02', 100, 101, 99, 100),
      bar('2026-01-03', 100, 101, 99, 100),
    ];
    const filtered = filterCandlesForSignalWindow(candles, baseSignal.createdAt, THROUGH_DAY);
    expect(filtered.map((c) => c.ts.slice(0, 10))).toEqual(['2026-01-02', '2026-01-03']);
  });

  it('handles Date ts values from MySQL driver', () => {
    // MySQL driver returns Date objects at runtime despite Candle.ts typing.
    const candles = [
      { ts: new Date('2026-01-01T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { ts: new Date('2026-01-02T00:00:00.000Z'), open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { ts: new Date('2026-01-03T00:00:00.000Z'), open: 100, high: 112, low: 99, close: 111, volume: 1 },
    ] as unknown as Candle[];
    const filtered = filterCandlesForSignalWindow(candles, baseSignal.createdAt, THROUGH_DAY);
    expect(filtered).toHaveLength(2);

    const r = evaluateOutcomeResolution(
      baseSignal,
      candles,
      SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS,
      THROUGH_DAY,
    )!;
    expect(r.outcome).toBe('T1_HIT');
    expect(r.candleCheckCount).toBe(2);
  });
});

describe('tradingDaysBetween', () => {
  it('counts weekdays inclusively', () => {
    expect(tradingDaysBetween('2026-01-05', '2026-01-09')).toBe(5);
  });
});
