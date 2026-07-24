import { describe, expect, it } from 'vitest';
import {
  parseMysqlUtcDatetime,
  toMysqlUtcDatetime,
} from '@/lib/broker/connections/authTransactions';

describe('broker auth transaction UTC datetime helpers', () => {
  it('round-trips UTC wall-clock MySQL datetimes', () => {
    const now = Date.UTC(2026, 6, 24, 11, 0, 0); // 11:00Z
    const sql = toMysqlUtcDatetime(new Date(now + 8 * 60 * 1000));
    expect(sql).toBe('2026-07-24 11:08:00');
    expect(parseMysqlUtcDatetime(sql)).toBe(now + 8 * 60 * 1000);
  });

  it('does not treat UTC expiry as already expired in positive-offset timezones', () => {
    // Regression: new Date('2026-07-24 11:08:00') is local-time in Node and
    // immediately expired transactions for Asia/Calcutta (+05:30).
    const futureUtc = Date.now() + 5 * 60 * 1000;
    const sql = toMysqlUtcDatetime(new Date(futureUtc));
    const parsed = parseMysqlUtcDatetime(sql);
    expect(parsed).toBeGreaterThan(Date.now());
    // Naive local parse must disagree in non-UTC zones (documents the bug).
    if (new Date().getTimezoneOffset() !== 0) {
      expect(new Date(sql).getTime()).not.toBe(parsed);
    }
  });

  it('rejects Date#toString wall-clock values that are not ISO MySQL datetimes', () => {
    expect(
      Number.isNaN(
        parseMysqlUtcDatetime('Fri Jul 24 2026 12:14:35 GMT+0530 (India Standard Time)'),
      ),
    ).toBe(true);
  });

  it('accepts already-suffixed ISO strings', () => {
    expect(parseMysqlUtcDatetime('2026-07-24T11:08:00.000Z')).toBe(
      Date.UTC(2026, 6, 24, 11, 8, 0),
    );
  });
});
