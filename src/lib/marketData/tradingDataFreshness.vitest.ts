/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { getLatestCompletedTradingDay } from '@/lib/marketData/marketHours';

describe('getLatestCompletedTradingDay', () => {
  it('does not demand a weekend calendar day as EOD target', () => {
    // Sunday 2026-08-09 12:00 IST = 2026-08-09T06:30:00Z
    const sundayIstNoon = Date.parse('2026-08-09T06:30:00.000Z');
    const day = getLatestCompletedTradingDay(sundayIstNoon);
    expect(day).toBe('2026-08-07'); // Friday
  });

  it('before close on a weekday uses prior session', () => {
    // Monday 2026-08-10 10:00 IST = 2026-08-10T04:30:00Z
    const monMorning = Date.parse('2026-08-10T04:30:00.000Z');
    const day = getLatestCompletedTradingDay(monMorning);
    expect(day).toBe('2026-08-07'); // prior completed Friday (Aug 8 Sat)
  });

  it('after close on a weekday uses that day', () => {
    // Monday 2026-08-10 16:00 IST = 2026-08-10T10:30:00Z
    const monAfterClose = Date.parse('2026-08-10T10:30:00.000Z');
    const day = getLatestCompletedTradingDay(monAfterClose);
    expect(day).toBe('2026-08-10');
  });
});
