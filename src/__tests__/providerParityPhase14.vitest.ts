/**
 * Provider parity — IndianAPI-only market-data resolution (broker streaming removed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(),
}));

import { getUserActiveDataSource } from '@/lib/broker/connections/activeDataSource';
import { resolveMarketDataProvider } from '@/lib/marketData/providerResolution';
import { labelCandleDataOrigin } from '@/lib/broker/connections/userMarketApi';

const getActive = vi.mocked(getUserActiveDataSource);
const originalEnv = { ...process.env };

function active(provider: 'zerodha' | 'shoonya' | null = null) {
  return {
    userId: 1,
    provider,
    connection: null,
    connectionId: null,
    isConnected: Boolean(provider),
    isActiveDataSource: Boolean(provider),
    needsSelection: false,
    reason: provider ? 'primary' : 'none',
    connectedProviders: provider ? [provider] : [],
    updatedAt: null,
  } as never;
}

describe('Phase 14 — IndianAPI-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test-key';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('never resolves broker for quotes even when connected', async () => {
    getActive.mockResolvedValue(active('zerodha'));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'quotes' });
    expect(result).toMatchObject({ ok: true, provider: 'indianapi' });
  });

  it('rejects live_ticks', async () => {
    getActive.mockResolvedValue(active(null));
    const result = await resolveMarketDataProvider({ userId: 1, capability: 'live_ticks' });
    expect(result.ok).toBe(false);
  });

  it('labels legacy broker candle sources as compatibility reads', () => {
    expect(labelCandleDataOrigin('zerodha')).toMatchObject({
      dataOrigin: 'legacy_broker_source',
      fallbackUsed: true,
    });
    expect(labelCandleDataOrigin('indianapi')).toMatchObject({
      dataOrigin: 'indianapi_warehouse',
      fallbackUsed: false,
    });
  });
});
