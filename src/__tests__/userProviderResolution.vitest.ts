/**
 * resolveUserLiveProvider — always not_connected (broker ticks retired).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(async () => ({
    userId: 1,
    provider: null,
    connection: null,
    connectionId: null,
    isConnected: false,
    isActiveDataSource: false,
    needsSelection: false,
    reason: 'none',
    connectedProviders: [],
    updatedAt: null,
  })),
}));

import {
  resolveUserLiveProvider,
  type UserLiveResolutionErr,
} from '@/lib/broker/connections/userProviderResolution';
import { getUserActiveDataSource } from '@/lib/broker/connections/activeDataSource';

describe('resolveUserLiveProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always returns not_connected — live broker ticks unsupported', async () => {
    const r = await resolveUserLiveProvider(1);
    expect(r.ok).toBe(false);
    const err = r as UserLiveResolutionErr;
    expect(err.code).toBe('not_connected');
    expect(err.message).toMatch(/IndianAPI/i);
    expect(getUserActiveDataSource).toHaveBeenCalledWith(1);
  });

  it('still returns not_connected when a legacy broker row exists', async () => {
    vi.mocked(getUserActiveDataSource).mockResolvedValueOnce({
      userId: 7,
      provider: 'zerodha',
      connection: null,
      connectionId: 'c1',
      isConnected: true,
      isActiveDataSource: true,
      needsSelection: false,
      reason: 'primary',
      connectedProviders: ['zerodha'],
      updatedAt: null,
    } as never);
    const r = await resolveUserLiveProvider(7);
    expect(r.ok).toBe(false);
    expect((r as UserLiveResolutionErr).code).toBe('not_connected');
  });
});
