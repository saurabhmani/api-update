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

function adapter() {
  return { connect: vi.fn().mockResolvedValue(undefined), isConnected: vi.fn().mockResolvedValue(true) };
}

describe('resolveMarketDataProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses IndianAPI when no broker is connected', async () => {
    getActive.mockResolvedValue(active(null));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'historical_candles' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi', fallbackUsed: true, fallbackReason: 'no_connected_provider' });
  });

  it('prefers an active Zerodha connection over IndianAPI', async () => {
    getActive.mockResolvedValue(active('zerodha'));
    getAdapter.mockReturnValue(adapter() as never);
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: true, provider: 'zerodha', fallbackUsed: false });
  });

  it('prefers an active Shoonya connection over IndianAPI', async () => {
    getActive.mockResolvedValue(active('shoonya'));
    getAdapter.mockReturnValue(adapter() as never);
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'historical_candles' });
    expect(result).toMatchObject({ ok: true, provider: 'shoonya', fallbackUsed: false });
  });

  it('respects the existing active-provider choice when both brokers are connected', async () => {
    getActive.mockResolvedValue(active('shoonya', { connectedProviders: ['zerodha', 'shoonya'] }));
    getAdapter.mockReturnValue(adapter() as never);
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: true, provider: 'shoonya' });
  });

  it('uses IndianAPI for a capability the selected broker does not support', async () => {
    getActive.mockResolvedValue(active('zerodha'));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'fundamentals' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi', fallbackReason: 'provider_capability_unsupported' });
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('returns a clear error when IndianAPI credentials are missing', async () => {
    delete process.env.INDIANAPI_API_KEY;
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

  it('does not write or create provider records during repeated resolution', async () => {
    getActive.mockResolvedValue(active(null));
    await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(getActive).toHaveBeenCalledTimes(2);
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('does not silently fall back after a connected provider fails initialization', async () => {
    getActive.mockResolvedValue(active('zerodha'));
    getAdapter.mockReturnValue({ connect: vi.fn().mockRejectedValue(new Error('expired token')), isConnected: vi.fn() } as never);
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: false, code: 'provider_initialization_failed', provider: 'zerodha' });
  });
});
