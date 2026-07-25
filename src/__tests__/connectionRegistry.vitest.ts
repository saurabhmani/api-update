import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('broker connection registry ownership', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    const { __resetBrokerConnectionRegistryForTests } = await import(
      '@/lib/marketData/connectionManager'
    );
    await __resetBrokerConnectionRegistryForTests();
  });

  it('keys instances by userId:provider and isolates users', async () => {
    process.env.KITE_API_KEY = 'testkey';
    const {
      upsertUserBrokerSession,
      getBrokerConnection,
      releaseBrokerConnection,
      listBrokerConnectionSnapshots,
      connectionKeyString,
    } = await import('@/lib/marketData/connectionManager');

    await upsertUserBrokerSession({
      userId: 1,
      provider: 'zerodha',
      accessToken: 'tok-user-1',
      connectStream: false,
    });
    await upsertUserBrokerSession({
      userId: 2,
      provider: 'zerodha',
      accessToken: 'tok-user-2',
      connectStream: false,
    });

    const a = getBrokerConnection({ userId: 1, provider: 'zerodha' });
    const b = getBrokerConnection({ userId: 2, provider: 'zerodha' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.keyString).toBe(connectionKeyString({ userId: '1', provider: 'zerodha' }));
    expect(b!.keyString).toBe('2:zerodha');
    expect((a as { getAccessToken?: () => string }).getAccessToken?.()).toBe('tok-user-1');
    expect((b as { getAccessToken?: () => string }).getAccessToken?.()).toBe('tok-user-2');

    await releaseBrokerConnection({ userId: 1, provider: 'zerodha' });
    expect(getBrokerConnection({ userId: 1, provider: 'zerodha' })).toBeNull();
    expect(getBrokerConnection({ userId: 2, provider: 'zerodha' })).not.toBeNull();

    const snaps = listBrokerConnectionSnapshots();
    expect(snaps.every((s) => s.keyString !== '1:zerodha')).toBe(true);
    expect(snaps.some((s) => s.keyString === '2:zerodha')).toBe(true);
  });

  it('system feed owner helpers respect SYSTEM_MARKET_DATA_USER_ID', async () => {
    process.env.SYSTEM_MARKET_DATA_USER_ID = '99';
    const { isSystemFeedOwner, shouldUpdateSystemKiteFeed } = await import(
      '@/lib/marketData/connectionManager'
    );
    expect(isSystemFeedOwner(99)).toBe(true);
    expect(isSystemFeedOwner(1)).toBe(false);
    expect(shouldUpdateSystemKiteFeed(99)).toBe(true);
    expect(shouldUpdateSystemKiteFeed(1)).toBe(false);
  });
});
