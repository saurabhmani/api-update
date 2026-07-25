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
  getLiveFeedProvider: vi.fn(() => 'kite'),
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
    hydrate.mockResolvedValue(true);
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

  it('hydrates token, ensures stack, and reconnects kite ticker after Zerodha OAuth', async () => {
    const { ensureStreamingAfterBrokerConnect } = await import(
      '@/lib/marketData/ensureBrokerStreaming'
    );
    const r = await ensureStreamingAfterBrokerConnect({
      userId: 42,
      broker: 'zerodha',
      accessToken: 'post-oauth-token',
    });

    expect(setAccessToken).toHaveBeenCalledWith('post-oauth-token');
    expect(ensureLiveMarketStack).toHaveBeenCalledTimes(1);
    expect(clearLoginRequired).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.tickerReconnected).toBe(true);
    expect(r.wsRunning).toBe(true);
    expect(r.baselineSymbols).toBe(12);
  });

  it('is idempotent across repeated calls', async () => {
    const { ensureStreamingAfterBrokerConnect } = await import(
      '@/lib/marketData/ensureBrokerStreaming'
    );
    const a = await ensureStreamingAfterBrokerConnect({
      userId: 42,
      broker: 'zerodha',
      accessToken: 'tok',
    });
    const b = await ensureStreamingAfterBrokerConnect({
      userId: 42,
      broker: 'zerodha',
      accessToken: 'tok',
    });
    expect(a.ok && b.ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(ensureLiveMarketStack).toHaveBeenCalledTimes(2);
  });

  it('still ensures stack for Shoonya without requiring an access token arg', async () => {
    const { ensureStreamingAfterBrokerConnect } = await import(
      '@/lib/marketData/ensureBrokerStreaming'
    );
    const r = await ensureStreamingAfterBrokerConnect({
      userId: 7,
      broker: 'shoonya',
    });
    expect(hydrate).toHaveBeenCalled();
    expect(ensureLiveMarketStack).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});
