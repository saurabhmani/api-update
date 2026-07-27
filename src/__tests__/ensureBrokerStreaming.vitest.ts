import { beforeEach, describe, expect, it, vi } from 'vitest';

const hydrate = vi.fn(async () => true);
const setAccessToken = vi.fn();
const ensureLiveMarketStack = vi.fn(async () => ({
  wsRunning: true,
  wsPort: 5001,
  baselineSymbols: 12,
}));
const clearLoginRequired = vi.fn();
const disconnect = vi.fn(async () => undefined);
const connect = vi.fn(async () => undefined);
const getStatus = vi.fn(() => ({
  state: 'open' as const,
  loginRequired: false,
  subscribedCount: 12,
  subscribed: 12,
  ticksCached: 0,
  tickRatePerSec: 0,
  lastTickAt: null,
  lastConnectedAt: Date.now(),
  lastError: null,
  reconnectAttempts: 0,
  packetsReceived: 0,
  bridgeErrorCount: 0,
}));
const upsertUserBrokerSession = vi.fn(async () => ({
  keyString: '42:zerodha',
  hasAuthenticatedSession: true,
  state: 'connected',
}));
const shouldUpdateSystemKiteFeed = vi.fn(() => true);

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({
    setAccessToken,
    hydrateAccessTokenFromSession: hydrate,
    getConfig: () => ({ apiKey: 'k', accessToken: 't' }),
  }),
}));

vi.mock('@/lib/marketData/ensureLiveMarketStack', () => ({
  ensureLiveMarketStack,
}));

vi.mock('@/lib/marketData/kiteTicker', () => ({
  getTicker: () => ({
    clearLoginRequired,
    disconnect,
    connect,
    getStatus,
  }),
}));

vi.mock('@/lib/marketData/providerFlags', () => ({
  getSystemLiveFeedProvider: vi.fn(() => 'kite'),
  getLiveFeedProvider: vi.fn(() => 'kite'),
}));

vi.mock('@/lib/marketData/connectionManager', () => ({
  shouldUpdateSystemKiteFeed,
  upsertUserBrokerSession,
  getBrokerConnection: vi.fn(() => null),
}));

vi.mock('@/lib/broker/connections', () => ({
  getDecryptedAccessTokenForUser: vi.fn(async () => null),
  getBrokerConnectionByUserAndBroker: vi.fn(async () => null),
}));

vi.mock('@/lib/marketData/marketSessionService', () => ({
  getStatus: vi.fn(async () => ({
    status: 'open',
    isOpen: true,
    tradingDate: '2026-07-25',
  })),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

describe('ensureStreamingAfterBrokerConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldUpdateSystemKiteFeed.mockReturnValue(true);
    upsertUserBrokerSession.mockResolvedValue({
      keyString: '42:zerodha',
      hasAuthenticatedSession: true,
      state: 'connected',
    });
    getStatus.mockReturnValue({
      state: 'open',
      loginRequired: false,
      subscribedCount: 12,
      subscribed: 12,
      ticksCached: 0,
      tickRatePerSec: 0,
      lastTickAt: null,
      lastConnectedAt: Date.now(),
      lastError: null,
      reconnectAttempts: 0,
      packetsReceived: 0,
      bridgeErrorCount: 0,
    });
  });

  it('upserts user connection and reconnects system ticker for feed owner', async () => {
    const { ensureStreamingAfterBrokerConnect } = await import(
      '@/lib/marketData/ensureBrokerStreaming'
    );
    const r = await ensureStreamingAfterBrokerConnect({
      userId: 42,
      broker: 'zerodha',
      accessToken: 'post-oauth-token',
    });

    expect(upsertUserBrokerSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        provider: 'zerodha',
        accessToken: 'post-oauth-token',
      }),
    );
    expect(setAccessToken).toHaveBeenCalledWith('post-oauth-token');
    expect(ensureLiveMarketStack).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.systemFeedUpdated).toBe(true);
    expect(r.userConnectionKey).toBe('42:zerodha');
  });

  it('does not replace system kite token for non-owner users', async () => {
    shouldUpdateSystemKiteFeed.mockReturnValue(false);
    const { ensureStreamingAfterBrokerConnect } = await import(
      '@/lib/marketData/ensureBrokerStreaming'
    );
    const r = await ensureStreamingAfterBrokerConnect({
      userId: 7,
      broker: 'zerodha',
      accessToken: 'user-7-token',
    });

    expect(upsertUserBrokerSession).toHaveBeenCalled();
    expect(setAccessToken).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.systemFeedUpdated).toBe(false);
  });

  it('still ensures stack for Shoonya without writing a Kite token', async () => {
    shouldUpdateSystemKiteFeed.mockReturnValue(false);
    const { ensureStreamingAfterBrokerConnect } = await import(
      '@/lib/marketData/ensureBrokerStreaming'
    );
    const r = await ensureStreamingAfterBrokerConnect({
      userId: 7,
      broker: 'shoonya',
    });
    expect(setAccessToken).not.toHaveBeenCalled();
    expect(ensureLiveMarketStack).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});
