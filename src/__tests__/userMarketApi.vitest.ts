/**
 * Phase 9 — user-facing APIs resolve active provider metadata.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
}));

describe('userMarketApi helpers', () => {
  beforeEach(async () => {
    const { _resetLiveFeedStateForTests } = await import(
      '@/lib/marketData/liveFeedState'
    );
    _resetLiveFeedStateForTests();
  });

  it('providerDataJson never includes credential-like keys', async () => {
    const { providerDataJson } = await import(
      '@/lib/broker/connections/userMarketApi'
    );
    const res = providerDataJson('shoonya', 'fresh', {
      quote: { symbol: 'RELIANCE', ltp: 100 },
    });
    const body = await res.json();
    expect(body).toEqual({
      provider: 'shoonya',
      status: 'fresh',
      data: { quote: { symbol: 'RELIANCE', ltp: 100 } },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/accessToken|refreshToken|api_secret|checksum/i);
  });

  it('instrumentFromQuery accepts symbol and instrumentKey', async () => {
    const { instrumentFromQuery } = await import(
      '@/lib/broker/connections/userMarketApi'
    );
    const a = instrumentFromQuery('RELIANCE');
    expect(a.symbol).toBe('RELIANCE');
    expect(a.exchange).toBe('NSE');
    expect(a.instrumentKey).toContain('RELIANCE');

    const b = instrumentFromQuery('NSE_EQ|TCS');
    expect(b.symbol).toBe('TCS');
  });

  it('withProviderMeta stamps provider without nesting', async () => {
    const { withProviderMeta } = await import(
      '@/lib/broker/connections/userMarketApi'
    );
    const out = withProviderMeta(
      { ok: true, signals: [] },
      { provider: 'zerodha', status: 'waiting_for_data' },
    );
    expect(out.provider).toBe('zerodha');
    expect(out.status).toBe('waiting_for_data');
    expect(out.ok).toBe(true);
  });
});
