/**
 * Phase 11 — explicit user live provider resolution.
 * No MARKET_DATA_PROVIDER, no silent cross-broker fallback.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(),
}));

vi.mock('@/lib/marketData/brokerProvider', () => ({
  getBrokerMarketDataProvider: vi.fn(),
}));

import { getUserActiveDataSource } from '@/lib/broker/connections/activeDataSource';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import {
  resolveUserLiveProvider,
  brokerErrorCode,
  mapBrokerFetchError,
} from '@/lib/broker/connections/userProviderResolution';
import { BrokerMarketDataError } from '@/lib/marketData/brokerProvider/types';

const getActive = vi.mocked(getUserActiveDataSource);
const getAdapter = vi.mocked(getBrokerMarketDataProvider);

describe('resolveUserLiveProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_connected when no active broker', async () => {
    getActive.mockResolvedValue({
      provider: null,
      isConnected: false,
      needsSelection: false,
      connectionId: null,
      connectedProviders: [],
    } as never);
    const r = await resolveUserLiveProvider(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_connected');
  });

  it('returns needs_selection when multiple connected and none selected', async () => {
    getActive.mockResolvedValue({
      provider: null,
      isConnected: false,
      needsSelection: true,
      connectionId: null,
      connectedProviders: ['zerodha', 'shoonya'],
    } as never);
    const r = await resolveUserLiveProvider(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('needs_selection');
  });

  it('returns shoonya_error when Shoonya active but unavailable', async () => {
    getActive.mockResolvedValue({
      provider: 'shoonya',
      isConnected: true,
      needsSelection: false,
      connectionId: 9,
      connectedProviders: ['shoonya'],
    } as never);
    getAdapter.mockReturnValue({
      connect: vi.fn().mockRejectedValue(new Error('token expired')),
      isConnected: vi.fn(),
    } as never);
    const r = await resolveUserLiveProvider(42);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('shoonya_error');
      expect(r.provider).toBe('shoonya');
    }
  });

  it('returns zerodha_error when Zerodha reports not connected after connect', async () => {
    getActive.mockResolvedValue({
      provider: 'zerodha',
      isConnected: true,
      needsSelection: false,
      connectionId: 3,
      connectedProviders: ['zerodha'],
    } as never);
    getAdapter.mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockResolvedValue(false),
    } as never);
    const r = await resolveUserLiveProvider(7);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('zerodha_error');
  });

  it('returns ok with adapter when active broker is connected', async () => {
    const adapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockResolvedValue(true),
    };
    getActive.mockResolvedValue({
      provider: 'zerodha',
      isConnected: true,
      needsSelection: false,
      connectionId: 3,
      connectedProviders: ['zerodha'],
    } as never);
    getAdapter.mockReturnValue(adapter as never);
    const r = await resolveUserLiveProvider(7);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe('zerodha');
      expect(r.adapter).toBe(adapter);
    }
  });

  it('brokerErrorCode / mapBrokerFetchError never cross-broker', () => {
    expect(brokerErrorCode('shoonya')).toBe('shoonya_error');
    expect(brokerErrorCode('zerodha')).toBe('zerodha_error');
    const mapped = mapBrokerFetchError(
      'shoonya',
      new BrokerMarketDataError('shoonya', 'provider_error', 'fail'),
    );
    expect(mapped.code).toBe('shoonya_error');
  });
});
