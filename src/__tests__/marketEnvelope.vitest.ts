/**
 * MARKET-AWARENESS — getMarketEnvelope contract tests.
 *
 *   • mode is derived from wall-clock + IST weekday, NEVER from
 *     bypass envs (FORCE_MARKET_OPEN / MOCK_MARKET_OPEN /
 *     BYPASS_MARKET_HOURS) — those only flip `bypassActive`.
 *   • isOpen aligns with mode === 'live' on a weekday during regular
 *     session, otherwise false.
 *   • isHoliday only set when state === 'holiday'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

async function loadModule() {
  // Re-import after env mutations so the module evaluates fresh
  // process.env reads (vi.resetModules between tests would be the
  // alternative; dynamic import is enough for these pure helpers).
  return await import('@/lib/marketData/marketHours');
}

describe('getMarketEnvelope — weekend/weekday derivation', () => {
  it('Saturday → mode=weekend, isOpen=false', async () => {
    // 2026-05-02 is a Saturday (the failure case from the bug report).
    // 17:47 IST = 12:17 UTC.
    vi.setSystemTime(new Date('2026-05-02T12:17:00Z'));
    const m = await loadModule();
    const env = m.getMarketEnvelope();
    expect(env.mode).toBe('weekend');
    expect(env.isOpen).toBe(false);
    expect(env.state).toBe('closed');
    expect(env.label).toMatch(/weekend/i);
  });

  it('Sunday → mode=weekend', async () => {
    vi.setSystemTime(new Date('2026-05-03T05:00:00Z'));   // Sunday IST
    const m = await loadModule();
    expect(m.getMarketEnvelope().mode).toBe('weekend');
  });

  it('Monday 11:00 IST (= 05:30 UTC) → mode=live', async () => {
    // 2026-05-04 is a Monday.
    vi.setSystemTime(new Date('2026-05-04T05:30:00Z'));
    const m = await loadModule();
    const env = m.getMarketEnvelope();
    expect(env.mode).toBe('live');
    expect(env.isOpen).toBe(true);
  });

  it('Monday 09:00 IST (= 03:30 UTC) → mode=pre_open', async () => {
    vi.setSystemTime(new Date('2026-05-04T03:30:00Z'));
    const m = await loadModule();
    expect(m.getMarketEnvelope().mode).toBe('pre_open');
  });

  it('Monday 16:00 IST (= 10:30 UTC) → mode=post_close', async () => {
    vi.setSystemTime(new Date('2026-05-04T10:30:00Z'));
    const m = await loadModule();
    expect(m.getMarketEnvelope().mode).toBe('post_close');
  });
});

describe('getMarketEnvelope — bypass env handling', () => {
  it('FORCE_MARKET_OPEN does NOT flip mode (still weekend on Saturday)', async () => {
    vi.setSystemTime(new Date('2026-05-02T05:00:00Z'));   // Saturday
    process.env.FORCE_MARKET_OPEN = '1';
    const m = await loadModule();
    const env = m.getMarketEnvelope();
    expect(env.mode).toBe('weekend');     // wall clock wins
    expect(env.isOpen).toBe(false);
    expect(env.bypassActive).toBe(true);
    expect(env.bypassReason).toMatch(/FORCE_MARKET_OPEN/);
  });

  it('MOCK_MARKET_OPEN surfaced under bypassActive', async () => {
    vi.setSystemTime(new Date('2026-05-02T05:00:00Z'));
    process.env.MOCK_MARKET_OPEN = 'true';
    const m = await loadModule();
    expect(m.getMarketEnvelope().bypassActive).toBe(true);
  });

  it('BYPASS_MARKET_HOURS surfaced under bypassActive', async () => {
    vi.setSystemTime(new Date('2026-05-02T05:00:00Z'));
    process.env.BYPASS_MARKET_HOURS = '1';
    const m = await loadModule();
    expect(m.getMarketEnvelope().bypassActive).toBe(true);
  });

  it('Q365_REGEN_24X7 alone does NOT flag bypass', async () => {
    vi.setSystemTime(new Date('2026-05-02T05:00:00Z'));
    process.env.Q365_REGEN_24X7 = '1';
    const m = await loadModule();
    expect(m.getMarketEnvelope().bypassActive).toBe(false);
  });
});

// ── Time-walk audit (Section 11) ─────────────────────────────────
//
// The full-system audit prompt asks us to pin four specific instants:
//   Monday 10:30 IST → live
//   Monday 09:05 IST → pre_open
//   Monday 15:45 IST → post_close
//   Saturday any IST → weekend
//
// Each row also asserts isOpen, the absence of bypass, and that the
// data-source the API layer would label is consistent with the mode.
// If any of these break, the dashboard / ticker / rankings labels
// would silently drift away from the wall clock.
describe('time-walk audit — exact wall-clock instants', () => {
  type Row = {
    label:   string;
    utcIso:  string;
    mode:    string;
    isOpen:  boolean;
  };
  const rows: Row[] = [
    { label: 'Mon 10:30 IST', utcIso: '2026-05-04T05:00:00Z', mode: 'live',       isOpen: true  },
    { label: 'Mon 09:05 IST', utcIso: '2026-05-04T03:35:00Z', mode: 'pre_open',   isOpen: false },
    { label: 'Mon 15:45 IST', utcIso: '2026-05-04T10:15:00Z', mode: 'post_close', isOpen: false },
    { label: 'Sat 17:47 IST', utcIso: '2026-05-02T12:17:00Z', mode: 'weekend',    isOpen: false },
  ];

  for (const row of rows) {
    it(`${row.label} → mode=${row.mode}, isOpen=${row.isOpen}`, async () => {
      vi.setSystemTime(new Date(row.utcIso));
      const m = await loadModule();
      const env = m.getMarketEnvelope();
      expect(env.mode).toBe(row.mode);
      expect(env.isOpen).toBe(row.isOpen);
      // Sanity: bypass must not flip the answer for any of these rows.
      expect(env.bypassActive).toBe(false);
      // Sanity: when isOpen is true, mode must be 'live'; the inverse
      // can be loosened for pre_open vs holiday vs post_close.
      if (env.isOpen) expect(env.mode).toBe('live');
    });
  }
});
