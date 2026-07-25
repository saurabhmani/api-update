/**
 * Phase 7 — streaming lifecycle equivalence (Zerodha + Shoonya share StreamingLifecycle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('StreamingLifecycle (shared Zerodha/Shoonya guarantees)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function load() {
    const mod = await import(
      '@/lib/marketData/connectionManager/streamingLifecycle'
    );
    return mod;
  }

  it('connect is idempotent when already connected', async () => {
    const { StreamingLifecycle } = await load();
    let opens = 0;
    const life = new StreamingLifecycle('t', {
      openWire: (g) => {
        opens += 1;
        life.markAuthenticated(g);
      },
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    await life.connect();
    await life.connect();
    await life.connect();
    expect(opens).toBe(1);
    expect(life.__isConnected()).toBe(true);
  });

  it('disconnect is idempotent', async () => {
    const { StreamingLifecycle } = await load();
    let closes = 0;
    const life = new StreamingLifecycle('t', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => {
        closes += 1;
      },
      restoreSubscriptions: () => undefined,
    });
    await life.connect();
    await life.disconnect();
    await life.disconnect();
    await life.disconnect();
    expect(closes).toBeGreaterThanOrEqual(2); // connect closeWire + disconnect
    expect(life.__isConnected()).toBe(false);
  });

  it('deduplicates concurrent connect attempts', async () => {
    const { StreamingLifecycle } = await load();
    let opens = 0;
    let resolveOpen: (() => void) | null = null;
    const life = new StreamingLifecycle('t', {
      openWire: async (g) => {
        opens += 1;
        await new Promise<void>((r) => {
          resolveOpen = () => {
            life.markAuthenticated(g);
            r();
          };
        });
      },
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });

    const a = life.connect();
    const b = life.connect();
    const c = life.connect();
    // Deduped before openWire runs (await closeWire microtask).
    expect(life.__isConnecting()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(opens).toBe(1);
    resolveOpen?.();
    await Promise.all([a, b, c]);
    expect(opens).toBe(1);
  });

  it('cancels reconnect timer on disconnect and session bump', async () => {
    const { StreamingLifecycle } = await load();
    const life = new StreamingLifecycle('t', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    await life.connect();
    const gen = life.sessionVersion;
    life.handleWireClosed(gen, 'disconnect');
    expect(life.__hasReconnectTimer()).toBe(true);

    await life.disconnect();
    expect(life.__hasReconnectTimer()).toBe(false);

    // Re-arm then bump credentials
    life.intentionalClose = false;
    life.permanentAuthFailure = false;
    await life.connect();
    life.handleWireClosed(life.sessionVersion, 'network timeout');
    expect(life.__hasReconnectTimer()).toBe(true);
    life.bumpSession('oauth');
    expect(life.__hasReconnectTimer()).toBe(false);
  });

  it('stale sockets cannot reconnect with old credentials', async () => {
    const { StreamingLifecycle } = await load();
    let opens = 0;
    const life = new StreamingLifecycle('t', {
      openWire: (g) => {
        opens += 1;
        life.markAuthenticated(g);
      },
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    await life.connect();
    const oldGen = life.sessionVersion;
    life.bumpSession('new_oauth');
    life.handleWireClosed(oldGen, 'disconnect');
    expect(life.__hasReconnectTimer()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    // No reconnect from stale generation
    expect(opens).toBe(1);
  });

  it('restores subscriptions after reconnect auth', async () => {
    const { StreamingLifecycle } = await load();
    const restores: number[] = [];
    const life = new StreamingLifecycle('t', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => undefined,
      restoreSubscriptions: () => {
        restores.push(life.subscriptionCount());
      },
    });
    life.addSubscriptions(['a', 'b', 'a']);
    expect(life.subscriptionCount()).toBe(2);
    await life.connect();
    expect(restores[0]).toBe(2);

    life.handleWireClosed(life.sessionVersion, 'econnreset');
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.runOnlyPendingTimersAsync();
    // reconnect connect → markAuthenticated → restore
    expect(restores.length).toBeGreaterThanOrEqual(2);
    expect(restores.at(-1)).toBe(2);
  });

  it('uses bounded reconnect backoff', async () => {
    const { reconnectDelayMs, MAX_RECONNECT_ATTEMPTS, RECONNECT_MAX_MS } =
      await load();
    expect(reconnectDelayMs(1)).toBe(3_000);
    expect(reconnectDelayMs(5)).toBe(15_000);
    expect(reconnectDelayMs(100)).toBe(RECONNECT_MAX_MS);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(40);
  });

  it('permanent auth errors stop retrying and request login', async () => {
    const { StreamingLifecycle, classifyStreamError } = await load();
    expect(classifyStreamError('Invalid session')).toBe('permanent_auth');
    expect(classifyStreamError('token expired')).toBe('permanent_auth');

    let login = 0;
    const life = new StreamingLifecycle('t', {
      openWire: (g) => life.markAuthenticated(g),
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
      onLoginRequired: () => {
        login += 1;
      },
    });
    await life.connect();
    life.handleWireClosed(life.sessionVersion, 'session expired');
    expect(life.permanentAuthFailure).toBe(true);
    expect(life.__hasReconnectTimer()).toBe(false);
    expect(login).toBe(1);

    await expect(life.connect()).rejects.toThrow(/login_required/);
  });

  it('temporary network errors schedule safe retry', async () => {
    const { StreamingLifecycle, classifyStreamError } = await load();
    expect(classifyStreamError('ECONNRESET')).toBe('temporary_network');
    expect(classifyStreamError('socket hang up')).toBe('temporary_network');

    let opens = 0;
    const life = new StreamingLifecycle('t', {
      openWire: (g) => {
        opens += 1;
        if (opens === 1) life.markAuthenticated(g);
        else life.markAuthenticated(g);
      },
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    await life.connect();
    life.handleWireClosed(life.sessionVersion, 'ECONNRESET');
    expect(life.__hasReconnectTimer()).toBe(true);
    expect(life.permanentAuthFailure).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.runOnlyPendingTimersAsync();
    expect(opens).toBe(2);
  });

  it('does not duplicate subscription refs', async () => {
    const { StreamingLifecycle } = await load();
    const life = new StreamingLifecycle('t', {
      openWire: () => undefined,
      closeWire: () => undefined,
      restoreSubscriptions: () => undefined,
    });
    expect(life.addSubscriptions(['1', '1', '2'])).toEqual(['1', '2']);
    expect(life.addSubscriptions(['2', '3'])).toEqual(['3']);
    expect(life.subscriptionCount()).toBe(3);
  });
});

describe('tick pipeline (normalize → keyed liveFeedState → broadcast)', () => {
  it('records live feed for tick.userId+provider only', async () => {
    const { _resetLiveFeedStateForTests, getLiveFeedStateFor } = await import(
      '@/lib/marketData/liveFeedState'
    );
    _resetLiveFeedStateForTests();

    const { publishNormalizedLiveTick } = await import(
      '@/lib/marketData/connectionManager/tickPipeline'
    );
    const { tickBus } = await import('@/lib/marketData/tickBus');
    const { MARKET_TICK_EVENT } = await import(
      '@/lib/marketData/marketStreamTypes'
    );

    const marketTicks: unknown[] = [];
    const onMarket = (t: unknown) => marketTicks.push(t);
    tickBus.on(MARKET_TICK_EVENT, onMarket);

    publishNormalizedLiveTick({
      provider: 'zerodha',
      userId: '1',
      instrumentKey: 'NSE_EQ|RELIANCE',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      brokerToken: '738561',
      lastPrice: 100,
      close: 95,
      receivedAt: new Date().toISOString(),
    });

    const z1 = getLiveFeedStateFor({ userId: '1', provider: 'zerodha' });
    const s1 = getLiveFeedStateFor({ userId: '1', provider: 'shoonya' });
    const z2 = getLiveFeedStateFor({ userId: '2', provider: 'zerodha' });

    expect(z1.lastReceivedAt).toBeTruthy();
    expect(s1.lastReceivedAt).toBeUndefined();
    expect(z2.lastReceivedAt).toBeUndefined();
    expect(marketTicks).toHaveLength(1);

    tickBus.off(MARKET_TICK_EVENT, onMarket);
  });
});

describe('provider instances share lifecycle semantics', () => {
  it('Zerodha authenticate bumps session and cancels reconnect', async () => {
    process.env.KITE_API_KEY = 'testkey';
    const { ZerodhaConnectionInstance } = await import(
      '@/lib/marketData/connectionManager/zerodhaInstance'
    );
    const inst = new ZerodhaConnectionInstance({ userId: '42', provider: 'zerodha' });
    await inst.authenticate({ accessToken: 'tok1' });
    const life = inst.__lifecycle();
    const v1 = life.sessionVersion;
    // Simulate reconnect armed
    life.handleWireClosed(v1, 'disconnect');
    expect(life.__hasReconnectTimer()).toBe(true);

    await inst.authenticate({ accessToken: 'tok2' });
    expect(life.sessionVersion).toBeGreaterThan(v1);
    expect(life.__hasReconnectTimer()).toBe(false);
  });

  it('Shoonya updateSession only bumps when credentials change', async () => {
    const { ShoonyaTicker } = await import(
      '@/lib/marketData/brokerProvider/shoonya/ticker'
    );
    const { NormalizedTickBus } = await import(
      '@/lib/marketData/brokerProvider/tickBus'
    );
    const bus = new NormalizedTickBus();
    const ticker = new ShoonyaTicker(
      { userId: 7, accessToken: 'a', uid: 'u', actid: 'u' },
      bus,
    );
    const life = ticker.__lifecycle();
    const v0 = life.sessionVersion;
    ticker.updateSession({ userId: 7, accessToken: 'a', uid: 'u', actid: 'u' });
    expect(life.sessionVersion).toBe(v0);
    ticker.updateSession({ userId: 7, accessToken: 'b', uid: 'u', actid: 'u' });
    expect(life.sessionVersion).toBe(v0 + 1);
  });
});
