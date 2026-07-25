/**
 * Phase 14 — Provider parity tests.
 *
 * Covers: resolution, connection isolation, streaming contract,
 * API routing, and failure cases for Zerodha + Shoonya.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
}));

vi.mock('@/lib/broker/connections/activeDataSource', () => ({
  getUserActiveDataSource: vi.fn(),
  ActiveDataSourceError: class ActiveDataSourceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ActiveDataSourceError';
      this.code = code;
    }
  },
}));

vi.mock('@/lib/marketData/brokerProvider', () => ({
  getBrokerMarketDataProvider: vi.fn(),
  listBrokerMarketDataProviders: vi.fn(() => []),
}));

import { isMarketOpen } from '@/lib/marketData/marketHours';
import {
  getUserActiveDataSource,
  ActiveDataSourceError,
} from '@/lib/broker/connections/activeDataSource';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import {
  resolveUserLiveProvider,
  mapBrokerFetchError,
  brokerErrorCode,
} from '@/lib/broker/connections/userProviderResolution';
import { BrokerMarketDataError } from '@/lib/marketData/brokerProvider/types';
import {
  _resetLiveFeedStateForTests,
  getLiveFeedStateFor,
  setLiveFeedConnectionPhase,
  recordLiveFeedTick,
} from '@/lib/marketData/liveFeedState';

const getActive = vi.mocked(getUserActiveDataSource);
const getAdapter = vi.mocked(getBrokerMarketDataProvider);

function activeOf(
  provider: 'zerodha' | 'shoonya' | null,
  extras: Record<string, unknown> = {},
) {
  return {
    userId: 1,
    provider,
    connection: provider ? { id: `bc_${provider}` } : null,
    connectionId: provider ? `bc_${provider}` : null,
    isConnected: Boolean(provider),
    isActiveDataSource: Boolean(provider),
    needsSelection: false,
    reason: provider ? 'primary' : 'none',
    connectedProviders: provider ? [provider] : [],
    updatedAt: new Date().toISOString(),
    ...extras,
  } as never;
}

function okAdapter(name: string) {
  return {
    name,
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    fetchQuote: vi.fn().mockResolvedValue([{ symbol: 'RELIANCE', ltp: 100 }]),
  };
}

// ════════════════════════════════════════════════════════════════
describe('Phase 14 — provider resolution', () => {
  beforeEach(() => {
    getActive.mockReset();
    getAdapter.mockReset();
    delete process.env.MARKET_DATA_PROVIDER;
  });

  it('Zerodha-only user resolves Zerodha', async () => {
    getActive.mockResolvedValue(activeOf('zerodha', { connectedProviders: ['zerodha'] }));
    const adapter = okAdapter('zerodha');
    getAdapter.mockReturnValue(adapter as never);
    const r = await resolveUserLiveProvider(11);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe('zerodha');
      expect(r.adapter).toBe(adapter);
    }
    expect(getAdapter).toHaveBeenCalledWith('zerodha');
  });

  it('Shoonya-only user resolves Shoonya', async () => {
    getActive.mockResolvedValue(activeOf('shoonya', { connectedProviders: ['shoonya'] }));
    const adapter = okAdapter('shoonya');
    getAdapter.mockReturnValue(adapter as never);
    const r = await resolveUserLiveProvider(12);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provider).toBe('shoonya');
    expect(getAdapter).toHaveBeenCalledWith('shoonya');
  });

  it('user with both resolves explicitly selected broker', async () => {
    getActive.mockResolvedValue(
      activeOf('shoonya', {
        connectedProviders: ['zerodha', 'shoonya'],
        reason: 'primary',
      }),
    );
    getAdapter.mockReturnValue(okAdapter('shoonya') as never);
    const r = await resolveUserLiveProvider(13);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provider).toBe('shoonya');
    expect(getAdapter).toHaveBeenCalledWith('shoonya');
    expect(getAdapter).not.toHaveBeenCalledWith('zerodha');
  });

  it('no broker returns not_connected', async () => {
    getActive.mockResolvedValue(activeOf(null));
    const r = await resolveUserLiveProvider(14);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_connected');
    expect(getAdapter).not.toHaveBeenCalled();
  });

  it('disconnected active broker does not silently switch to the other', async () => {
    getActive.mockResolvedValue(
      activeOf('zerodha', {
        isConnected: true,
        connectedProviders: ['zerodha', 'shoonya'],
      }),
    );
    getAdapter.mockReturnValue({
      connect: vi.fn().mockRejectedValue(new Error('session expired')),
      isConnected: vi.fn(),
    } as never);
    const r = await resolveUserLiveProvider(15);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('zerodha_error');
      expect(r.provider).toBe('zerodha');
    }
    expect(getAdapter).toHaveBeenCalledWith('zerodha');
    expect(getAdapter).not.toHaveBeenCalledWith('shoonya');
  });

  it("one user's provider cannot affect another user's resolution", async () => {
    getActive
      .mockResolvedValueOnce(activeOf('zerodha'))
      .mockResolvedValueOnce(activeOf('shoonya'));
    const z = okAdapter('zerodha');
    const s = okAdapter('shoonya');
    getAdapter
      .mockReturnValueOnce(z as never)
      .mockReturnValueOnce(s as never);

    const a = await resolveUserLiveProvider(100);
    const b = await resolveUserLiveProvider(200);
    expect(a.ok && a.provider).toBe('zerodha');
    expect(b.ok && b.provider).toBe('shoonya');
  });

  it('MARKET_DATA_PROVIDER env does not change user resolution', async () => {
    process.env.MARKET_DATA_PROVIDER = 'yahoo';
    getActive.mockResolvedValue(activeOf('shoonya'));
    getAdapter.mockReturnValue(okAdapter('shoonya') as never);
    const r = await resolveUserLiveProvider(16);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provider).toBe('shoonya');
    expect(getAdapter).toHaveBeenCalledWith('shoonya');
  });
});

// ════════════════════════════════════════════════════════════════
describe('Phase 14 — connection isolation', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    process.env.KITE_API_KEY = 'testkey';
    const { __resetBrokerConnectionRegistryForTests } = await import(
      '@/lib/marketData/connectionManager'
    );
    await __resetBrokerConnectionRegistryForTests();
  });

  it('two Zerodha users have separate sessions', async () => {
    const {
      upsertUserBrokerSession,
      getBrokerConnection,
    } = await import('@/lib/marketData/connectionManager');

    await upsertUserBrokerSession({
      userId: 1,
      provider: 'zerodha',
      accessToken: 'z-tok-1',
      connectStream: false,
    });
    await upsertUserBrokerSession({
      userId: 2,
      provider: 'zerodha',
      accessToken: 'z-tok-2',
      connectStream: false,
    });

    const a = getBrokerConnection({ userId: 1, provider: 'zerodha' });
    const b = getBrokerConnection({ userId: 2, provider: 'zerodha' });
    expect(a!.keyString).toBe('1:zerodha');
    expect(b!.keyString).toBe('2:zerodha');
    expect((a as { getAccessToken?: () => string }).getAccessToken?.()).toBe('z-tok-1');
    expect((b as { getAccessToken?: () => string }).getAccessToken?.()).toBe('z-tok-2');
  });

  it('two Shoonya users have separate sessions', async () => {
    const {
      upsertUserBrokerSession,
      getBrokerConnection,
    } = await import('@/lib/marketData/connectionManager');

    await upsertUserBrokerSession({
      userId: 3,
      provider: 'shoonya',
      accessToken: 's-tok-3',
      accountId: 'UID3',
      connectStream: false,
    });
    await upsertUserBrokerSession({
      userId: 4,
      provider: 'shoonya',
      accessToken: 's-tok-4',
      accountId: 'UID4',
      connectStream: false,
    });

    const a = getBrokerConnection({ userId: 3, provider: 'shoonya' });
    const b = getBrokerConnection({ userId: 4, provider: 'shoonya' });
    expect(a!.keyString).toBe('3:shoonya');
    expect(b!.keyString).toBe('4:shoonya');
    expect(a).not.toBe(b);
  });

  it('one Zerodha and one Shoonya user stream independently', async () => {
    const {
      upsertUserBrokerSession,
      getBrokerConnection,
      listBrokerConnectionSnapshots,
    } = await import('@/lib/marketData/connectionManager');

    await upsertUserBrokerSession({
      userId: 5,
      provider: 'zerodha',
      accessToken: 'z5',
      connectStream: false,
    });
    await upsertUserBrokerSession({
      userId: 6,
      provider: 'shoonya',
      accessToken: 's6',
      accountId: 'UID6',
      connectStream: false,
    });

    expect(getBrokerConnection({ userId: 5, provider: 'zerodha' })!.keyString).toBe('5:zerodha');
    expect(getBrokerConnection({ userId: 6, provider: 'shoonya' })!.keyString).toBe('6:shoonya');
    expect(getBrokerConnection({ userId: 5, provider: 'shoonya' })).toBeNull();
    expect(getBrokerConnection({ userId: 6, provider: 'zerodha' })).toBeNull();

    const snaps = listBrokerConnectionSnapshots().map((s) => s.keyString).sort();
    expect(snaps).toEqual(['5:zerodha', '6:shoonya']);
  });

  it('disconnecting one user preserves the other connection', async () => {
    const {
      upsertUserBrokerSession,
      releaseBrokerConnection,
      getBrokerConnection,
    } = await import('@/lib/marketData/connectionManager');

    await upsertUserBrokerSession({
      userId: 7,
      provider: 'zerodha',
      accessToken: 'z7',
      connectStream: false,
    });
    await upsertUserBrokerSession({
      userId: 8,
      provider: 'zerodha',
      accessToken: 'z8',
      connectStream: false,
    });

    await releaseBrokerConnection({ userId: 7, provider: 'zerodha' });
    expect(getBrokerConnection({ userId: 7, provider: 'zerodha' })).toBeNull();
    expect(getBrokerConnection({ userId: 8, provider: 'zerodha' })).not.toBeNull();
    expect(
      (getBrokerConnection({ userId: 8, provider: 'zerodha' }) as { getAccessToken?: () => string })
        .getAccessToken?.(),
    ).toBe('z8');
  });

  it("refreshing one user's token does not mutate another user's session", async () => {
    const {
      upsertUserBrokerSession,
      getBrokerConnection,
    } = await import('@/lib/marketData/connectionManager');

    await upsertUserBrokerSession({
      userId: 9,
      provider: 'zerodha',
      accessToken: 'old-9',
      connectStream: false,
    });
    await upsertUserBrokerSession({
      userId: 10,
      provider: 'zerodha',
      accessToken: 'stable-10',
      connectStream: false,
    });

    await upsertUserBrokerSession({
      userId: 9,
      provider: 'zerodha',
      accessToken: 'new-9',
      connectStream: false,
    });

    expect(
      (getBrokerConnection({ userId: 9, provider: 'zerodha' }) as { getAccessToken?: () => string })
        .getAccessToken?.(),
    ).toBe('new-9');
    expect(
      (getBrokerConnection({ userId: 10, provider: 'zerodha' }) as { getAccessToken?: () => string })
        .getAccessToken?.(),
    ).toBe('stable-10');
  });
});

// ════════════════════════════════════════════════════════════════
describe('Phase 14 — streaming contract (Zerodha + Shoonya)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetLiveFeedStateForTests();
    vi.mocked(isMarketOpen).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const provider of ['zerodha', 'shoonya'] as const) {
    describe(`${provider} adapter path`, () => {
      it('connect → subscribe → tick → freshness → disconnect → reconnect → restore', async () => {
        const { StreamingLifecycle } = await import(
          '@/lib/marketData/connectionManager/streamingLifecycle'
        );
        const { publishNormalizedLiveTick } = await import(
          '@/lib/marketData/connectionManager/tickPipeline'
        );

        const restores: number[] = [];
        let opens = 0;
        const life = new StreamingLifecycle(`${provider}-parity`, {
          openWire: (g) => {
            opens += 1;
            life.markAuthenticated(g);
          },
          closeWire: () => undefined,
          restoreSubscriptions: () => {
            restores.push(life.subscriptionCount());
          },
        });

        await life.connect();
        expect(life.__isConnected()).toBe(true);
        expect(opens).toBe(1);

        life.addSubscriptions(['RELIANCE', 'TCS', 'RELIANCE']);
        expect(life.subscriptionCount()).toBe(2);

        const userId = provider === 'zerodha' ? '21' : '22';
        publishNormalizedLiveTick({
          userId,
          provider,
          symbol: 'RELIANCE',
          exchange: 'NSE',
          instrumentKey: 'NSE_EQ|RELIANCE',
          brokerToken: '1',
          lastPrice: 2500,
          volume: 100,
          receivedAt: new Date().toISOString(),
        });

        const feed = getLiveFeedStateFor({ userId, provider });
        expect(feed.status).toBe('fresh');
        expect(feed.lastReceivedAt).toBeTypeOf('number');

        await life.disconnect();
        expect(life.__isConnected()).toBe(false);

        await life.connect();
        expect(opens).toBe(2);
        expect(restores.at(-1)).toBe(2);

        life.handleWireClosed(life.sessionVersion, 'websocket disconnect');
        expect(life.__hasReconnectTimer()).toBe(true);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.runOnlyPendingTimersAsync();
        expect(opens).toBeGreaterThanOrEqual(3);
        expect(restores.at(-1)).toBe(2);
      });
    });
  }
});

// ════════════════════════════════════════════════════════════════
describe('Phase 14 — API routing', () => {
  beforeEach(() => {
    getActive.mockReset();
    getAdapter.mockReset();
    _resetLiveFeedStateForTests();
  });

  it('Zerodha user API resolution uses Zerodha adapter', async () => {
    getActive.mockResolvedValue(activeOf('zerodha'));
    const adapter = okAdapter('zerodha');
    getAdapter.mockReturnValue(adapter as never);
    const r = await resolveUserLiveProvider(31);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe('zerodha');
      await r.adapter.fetchQuote?.(r.ctx, [] as never);
      expect(adapter.fetchQuote).toHaveBeenCalled();
    }
  });

  it('Shoonya user API resolution uses Shoonya adapter', async () => {
    getActive.mockResolvedValue(activeOf('shoonya'));
    const adapter = okAdapter('shoonya');
    getAdapter.mockReturnValue(adapter as never);
    const r = await resolveUserLiveProvider(32);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provider).toBe('shoonya');
  });

  it('API output accurately reports provider and origin', async () => {
    const {
      providerDataJson,
      withProviderMeta,
      labelCandleDataOrigin,
    } = await import('@/lib/broker/connections/userMarketApi');

    expect(labelCandleDataOrigin('zerodha')).toEqual({
      dataOrigin: 'zerodha_live',
      fallbackUsed: false,
    });
    expect(labelCandleDataOrigin('shoonya')).toEqual({
      dataOrigin: 'shoonya_live',
      fallbackUsed: false,
    });
    const yahoo = labelCandleDataOrigin('yahoo');
    expect(yahoo.dataOrigin).toBe('fallback');
    expect(yahoo.fallbackUsed).toBe(true);

    const res = providerDataJson(
      'shoonya',
      'fresh',
      { quote: { ltp: 1 } },
      { dataOrigin: 'shoonya_live', fallbackUsed: false },
    );
    const body = await res.json();
    expect(body.provider).toBe('shoonya');
    expect(body.status).toBe('fresh');
    expect(body.dataOrigin).toBe('shoonya_live');
    expect(body.fallbackUsed).toBe(false);

    const stamped = withProviderMeta(
      { signals: [] },
      {
        provider: 'zerodha',
        status: 'fresh',
        dataOrigin: 'zerodha_live',
        liveEnrichmentOrigin: 'zerodha_live',
        fallbackUsed: false,
      },
    );
    expect(stamped.provider).toBe('zerodha');
    expect(stamped.dataOrigin).toBe('zerodha_live');
    expect(stamped.liveEnrichmentOrigin).toBe('zerodha_live');
  });

  it('registry maps kite→zerodha and shoonya→shoonya (unmocked registry)', async () => {
    // Use dynamic import of the real registry module path to avoid this file's mock.
    const { getBrokerMarketDataProvider: realGet } = await vi.importActual<
      typeof import('@/lib/marketData/brokerProvider/registry')
    >('@/lib/marketData/brokerProvider/registry');
    expect(realGet('zerodha').name).toBe('zerodha');
    expect(realGet('kite').name).toBe('zerodha');
    expect(realGet('shoonya').name).toBe('shoonya');
  });

  it('no global MARKET_DATA_PROVIDER default changes API provider stamp', async () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    const { providerDataJson } = await import('@/lib/broker/connections/userMarketApi');
    const res = providerDataJson('shoonya', 'fresh', { ok: true });
    const body = await res.json();
    expect(body.provider).toBe('shoonya');
  });
});

// ════════════════════════════════════════════════════════════════
describe('Phase 14 — failure cases', () => {
  beforeEach(() => {
    getActive.mockReset();
    getAdapter.mockReset();
    _resetLiveFeedStateForTests();
    vi.mocked(isMarketOpen).mockReturnValue(true);
  });

  it('expired Zerodha token → login_required / zerodha_error', () => {
    const mapped = mapBrokerFetchError(
      'zerodha',
      new BrokerMarketDataError('zerodha', 'session_expired', 'token expired'),
    );
    expect(mapped.code).toBe('login_required');
    expect(brokerErrorCode('zerodha')).toBe('zerodha_error');
  });

  it('expired Shoonya session → login_required / shoonya_error', () => {
    const mapped = mapBrokerFetchError(
      'shoonya',
      new BrokerMarketDataError('shoonya', 'not_connected', 'session gone'),
    );
    expect(mapped.code).toBe('login_required');
    expect(
      mapBrokerFetchError(
        'shoonya',
        new BrokerMarketDataError('shoonya', 'provider_error', 'auth fail'),
      ).code,
    ).toBe('shoonya_error');
  });

  it('Redis unavailable — system kite hydrate fails closed without SYSTEM user', async () => {
    delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    const { getKiteClient } = await import('@/lib/kite/client');
    const client = getKiteClient();
    // Clear in-memory token so hydrate path runs
    const cfg = (client as unknown as { cfg: { accessToken: string } }).cfg;
    if (cfg) cfg.accessToken = '';
    const ok = await client.hydrateAccessTokenFromSession();
    expect(ok).toBe(false);
  });

  it('Database / active-source errors expose not_connected code', () => {
    const err = new ActiveDataSourceError('not_connected', 'db down');
    expect(err.code).toBe('not_connected');
    expect(err.message).toContain('db down');
  });

  it('WebSocket disconnect arms reconnect without dropping subscriptions', async () => {
    vi.useFakeTimers();
    const { StreamingLifecycle } = await import(
      '@/lib/marketData/connectionManager/streamingLifecycle'
    );
    const life = new StreamingLifecycle('ws-fail', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    life.addSubscriptions(['INFY']);
    await life.connect();
    life.handleWireClosed(life.sessionVersion, 'websocket disconnect');
    expect(life.__hasReconnectTimer()).toBe(true);
    expect(life.subscriptionCount()).toBe(1);
    vi.useRealTimers();
  });

  it('missing instrument mapping → instrument_unresolved', () => {
    const err = new BrokerMarketDataError(
      'zerodha',
      'instrument_unresolved',
      'no token for XYZ',
    );
    expect(err.code).toBe('instrument_unresolved');
    expect(mapBrokerFetchError('zerodha', err).code).toBe('zerodha_error');
  });

  it('concurrent OAuth bumps session and cancels stale reconnect', async () => {
    vi.useFakeTimers();
    const { StreamingLifecycle } = await import(
      '@/lib/marketData/connectionManager/streamingLifecycle'
    );
    const life = new StreamingLifecycle('oauth-race', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    await life.connect();
    const old = life.sessionVersion;
    life.handleWireClosed(old, 'drop');
    expect(life.__hasReconnectTimer()).toBe(true);
    life.bumpSession('concurrent_oauth');
    expect(life.__hasReconnectTimer()).toBe(false);
    life.handleWireClosed(old, 'stale');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(life.sessionVersion).toBeGreaterThan(old);
    vi.useRealTimers();
  });

  it('duplicate subscription is deduped', async () => {
    const { StreamingLifecycle } = await import(
      '@/lib/marketData/connectionManager/streamingLifecycle'
    );
    const life = new StreamingLifecycle('dedupe', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    life.addSubscriptions(['A', 'A', 'B', 'A']);
    expect(life.subscriptionCount()).toBe(2);
  });

  it('closed market status is provider-keyed', () => {
    vi.mocked(isMarketOpen).mockReturnValue(false);
    setLiveFeedConnectionPhase({ userId: '1', provider: 'zerodha' }, 'connected');
    expect(getLiveFeedStateFor({ userId: '1', provider: 'zerodha' }).status).toBe(
      'closed_market',
    );
  });

  it('no recent data → waiting_for_data (auth alone is not fresh)', () => {
    setLiveFeedConnectionPhase({ userId: '1', provider: 'shoonya' }, 'connected');
    const st = getLiveFeedStateFor({ userId: '1', provider: 'shoonya' });
    expect(st.status).toBe('waiting_for_data');
    expect(st.lastReceivedAt).toBeUndefined();
    expect(getLiveFeedStateFor({ userId: '2', provider: 'zerodha' }).status).toBe(
      'not_connected',
    );
  });

  it('tick for user A does not freshen user B', () => {
    setLiveFeedConnectionPhase({ userId: '1', provider: 'zerodha' }, 'connected');
    setLiveFeedConnectionPhase({ userId: '2', provider: 'zerodha' }, 'connected');
    recordLiveFeedTick(Date.now(), undefined, { userId: '1', provider: 'zerodha' });
    expect(getLiveFeedStateFor({ userId: '1', provider: 'zerodha' }).status).toBe('fresh');
    expect(getLiveFeedStateFor({ userId: '2', provider: 'zerodha' }).status).toBe(
      'waiting_for_data',
    );
  });
});
