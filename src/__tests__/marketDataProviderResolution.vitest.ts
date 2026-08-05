import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(),
}));
vi.mock('@/lib/marketData/brokerProvider', () => ({
  getBrokerMarketDataProvider: vi.fn(),
}));

import { getUserActiveDataSource } from '@/lib/broker/connections/activeDataSource';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import { resolveMarketDataProvider } from '@/lib/marketData/providerResolution';

const getActive = vi.mocked(getUserActiveDataSource);
const getAdapter = vi.mocked(getBrokerMarketDataProvider);
const originalEnv = { ...process.env };

function active(provider: 'zerodha' | 'shoonya' | null, extras: Record<string, unknown> = {}) {
  return {
    userId: 1, provider, connection: provider ? { id: `connection-${provider}` } : null,
    connectionId: provider ? `connection-${provider}` : null, isConnected: Boolean(provider),
    isActiveDataSource: Boolean(provider), needsSelection: false,
    reason: provider ? 'primary' : 'none', connectedProviders: provider ? [provider] : [],
    updatedAt: null, ...extras,
  } as never;
}

describe('resolveMarketDataProvider — IndianAPI-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves IndianAPI when no broker is connected', async () => {
    getActive.mockResolvedValue(active(null));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'historical_candles' });
    expect(result).toMatchObject({
      ok: true,
      provider: 'indianapi',
      providerKind: 'indianapi',
      fallbackUsed: false,
    });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('never resolves Zerodha even when connected', async () => {
    getActive.mockResolvedValue(active('zerodha'));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi', providerKind: 'indianapi' });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('never resolves Shoonya even when connected', async () => {
    getActive.mockResolvedValue(active('shoonya'));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'historical_candles' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi' });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('ignores dual-broker selection for market data', async () => {
    getActive.mockResolvedValue(active('shoonya', { connectedProviders: ['zerodha', 'shoonya'] }));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi' });
  });

  it('uses IndianAPI for fundamentals', async () => {
    getActive.mockResolvedValue(active('zerodha'));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'fundamentals' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi' });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('returns a clear error when IndianAPI credentials are missing', async () => {
    delete process.env.INDIANAPI_API_KEY;
    delete process.env.INDIANAPI_KEY;
    delete process.env.INDIAN_API_KEY;
    getActive.mockResolvedValue(active(null));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: false, code: 'indianapi_credentials_missing' });
  });

  it('returns a clear error when IndianAPI is disabled', async () => {
    process.env.INDIANAPI_ENABLED = 'false';
    getActive.mockResolvedValue(active(null));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: false, code: 'indianapi_disabled' });
  });

  it('rejects live_ticks as unsupported', async () => {
    getActive.mockResolvedValue(active(null));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'live_ticks' });
    expect(result).toMatchObject({ ok: false, code: 'indianapi_capability_unsupported' });
    expect(result.ok === false && result.message).toMatch(/live ticks/i);
  });

  it('does not write or create provider records during repeated resolution', async () => {
    getActive.mockResolvedValue(active(null));
    await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(getActive).toHaveBeenCalledTimes(2);
    expect(getAdapter).not.toHaveBeenCalled();
  });
});
