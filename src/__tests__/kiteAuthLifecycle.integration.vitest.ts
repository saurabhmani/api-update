import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
} from '@/lib/security/csp';

vi.mock('server-only', () => ({}));

const API_KEY = 'test-kite-api-key';
const API_SECRET = 'test-kite-api-secret-value';
const USER_A = '42';
const USER_B = '99';
const KITE_USER_ID = 'AB1234';
const ACCESS_TOKEN = 'kite-access-token-lifecycle';
const REQUEST_TOKEN = 'kite-request-token-lifecycle';

const SENSITIVE = [API_SECRET, ACCESS_TOKEN, REQUEST_TOKEN] as const;

function normalizeScript(script: string): string {
  return script.replace(/\s+/g, ' ').trim();
}

const CONSUME_AUTH_STATE_LUA = normalizeScript(`
local current = redis.call('GET', KEYS[1])
if not current then
  return 0
end
if current ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[1])
return 1
`);

const CREATE_COMPLETION_LUA = normalizeScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'quantorusUserId', ARGV[1],
  'kiteUserId', ARGV[2],
  'authenticatedAt', ARGV[3]
)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`);

const CONSUME_COMPLETION_LUA = normalizeScript(`
local quantorusUserId = redis.call('HGET', KEYS[1], 'quantorusUserId')
if not quantorusUserId then
  return nil
end
if quantorusUserId ~= ARGV[1] then
  return 'MISMATCH'
end
local kiteUserId = redis.call('HGET', KEYS[1], 'kiteUserId')
local authenticatedAt = redis.call('HGET', KEYS[1], 'authenticatedAt')
if not kiteUserId then
  return nil
end
redis.call('DEL', KEYS[1])
return cjson.encode({ kiteUserId = kiteUserId, authenticatedAt = authenticatedAt or '' })
`);

type StringEntry = { value: string; expiresAt: number | null };
type HashEntry = { fields: Map<string, string>; expiresAt: number | null };

type ActiveSession = {
  accessToken: string;
  kiteUserId: string;
  quantorusUserId: string;
  authenticatedAt: string;
};

const {
  fakeRedis,
  redisClientRef,
  mockRequireSession,
  mockGetKiteConfig,
  activeSessionRef,
  mockGetBrokerConnection,
  mockGetDecrypted,
  mockMarkStatus,
  mockClearActive,
} = vi.hoisted(() => {
  const activeSessionRef = { current: null as ActiveSession | null };
  class FakeHandoffRedis {
    private strings = new Map<string, StringEntry>();
    private hashes = new Map<string, HashEntry>();
    private now = Date.now();
    failNextSet = false;
    failNextEvalCreate = false;

    setNow(value: number): void {
      this.now = value;
    }

    clear(): void {
      this.strings.clear();
      this.hashes.clear();
      this.now = Date.now();
      this.failNextSet = false;
      this.failNextEvalCreate = false;
    }

    private purgeExpired(): void {
      for (const [key, entry] of this.strings) {
        if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
          this.strings.delete(key);
        }
      }
      for (const [key, entry] of this.hashes) {
        if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
          this.hashes.delete(key);
        }
      }
    }

    hasAuthStatePlaintext(state: string): boolean {
      this.purgeExpired();
      for (const key of this.strings.keys()) {
        if (key.includes(state)) return true;
      }
      return false;
    }

    authStateCount(): number {
      this.purgeExpired();
      return this.strings.size;
    }

    completionCount(): number {
      this.purgeExpired();
      return this.hashes.size;
    }

    hasCompletionForUser(quantorusUserId: string): boolean {
      this.purgeExpired();
      for (const entry of this.hashes.values()) {
        if (entry.fields.get('quantorusUserId') === quantorusUserId) return true;
      }
      return false;
    }

    async set(
      key: string,
      value: string,
      expiryMode?: 'EX',
      ttlSeconds?: number,
      setMode?: 'NX',
    ): Promise<'OK' | null> {
      this.purgeExpired();
      if (this.failNextSet) {
        this.failNextSet = false;
        throw new Error('redis unavailable');
      }
      if (setMode === 'NX' && this.strings.has(key)) return null;
      this.strings.set(key, {
        value,
        expiresAt: expiryMode === 'EX' && typeof ttlSeconds === 'number'
          ? this.now + ttlSeconds * 1000
          : null,
      });
      return 'OK';
    }

    async eval(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
      this.purgeExpired();
      const keys = args.slice(0, numKeys);
      const argv = args.slice(numKeys);
      const normalized = normalizeScript(script);

      if (normalized === CONSUME_AUTH_STATE_LUA) {
        const key = keys[0];
        const entry = this.strings.get(key);
        if (!entry) return 0;
        if (entry.value !== argv[0]) return 0;
        this.strings.delete(key);
        return 1;
      }

      if (normalized === CREATE_COMPLETION_LUA) {
        if (this.failNextEvalCreate) {
          this.failNextEvalCreate = false;
          throw new Error('redis unavailable');
        }
        const key = keys[0];
        if (this.hashes.has(key) || this.strings.has(key)) return 0;
        const ttlSeconds = Number(argv[3]);
        this.hashes.set(key, {
          fields: new Map([
            ['quantorusUserId', argv[0]],
            ['kiteUserId', argv[1]],
            ['authenticatedAt', argv[2]],
          ]),
          expiresAt: Number.isFinite(ttlSeconds) ? this.now + ttlSeconds * 1000 : null,
        });
        return 1;
      }

      if (normalized === CONSUME_COMPLETION_LUA) {
        const key = keys[0];
        const entry = this.hashes.get(key);
        if (!entry) return null;
        const quantorusUserId = entry.fields.get('quantorusUserId');
        if (!quantorusUserId) return null;
        if (quantorusUserId !== argv[0]) return 'MISMATCH';
        const kiteUserId = entry.fields.get('kiteUserId');
        const authenticatedAt = entry.fields.get('authenticatedAt') ?? '';
        if (!kiteUserId) return null;
        this.hashes.delete(key);
        return JSON.stringify({ kiteUserId, authenticatedAt });
      }

      throw new Error('Unsupported script in FakeHandoffRedis');
    }
  }

  const instance = new FakeHandoffRedis();
  return {
    fakeRedis: instance,
    redisClientRef: { current: instance as FakeHandoffRedis | null },
    mockRequireSession: vi.fn(),
    mockGetKiteConfig: vi.fn(),
    activeSessionRef,
    mockGetBrokerConnection: vi.fn(),
    mockGetDecrypted: vi.fn(),
    mockMarkStatus: vi.fn(),
    mockClearActive: vi.fn(),
  };
});

vi.mock('@/lib/redis', () => ({
  getRedisClient: () => redisClientRef.current,
}));

vi.mock('@/lib/session', () => ({
  requireSession: mockRequireSession,
}));

vi.mock('@/lib/kite/config', () => ({
  getKiteConfig: mockGetKiteConfig,
}));

vi.mock('@/lib/broker/oauth/zerodhaBridge', () => ({
  persistZerodhaBrokerConnection: vi.fn(async () => undefined),
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  saveActiveKiteSession: vi.fn(async (session: ActiveSession) => {
    activeSessionRef.current = session;
  }),
  getActiveKiteSession: vi.fn(async () => activeSessionRef.current),
  clearActiveKiteSession: mockClearActive,
}));

vi.mock('@/lib/broker/connections', () => ({
  getBrokerConnectionByUserAndBroker: mockGetBrokerConnection,
  getDecryptedAccessTokenForUser: mockGetDecrypted,
  markBrokerConnectionStatus: mockMarkStatus,
  isDataSourceBroker: (broker: string) => broker === 'zerodha' || broker === 'shoonya',
}));

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({
    getAccessToken: () => activeSessionRef.current?.accessToken ?? '',
    setAccessToken: vi.fn(),
  }),
  resetKiteClient: vi.fn(),
}));

vi.mock('@/lib/broker/repository/brokerRepository', () => ({
  disconnectBrokerAccount: vi.fn(async () => undefined),
}));

vi.mock('@/lib/broker/oauth/shoonya', () => ({
  resolveAppBaseUrl: () => 'http://localhost',
}));

function assertNoSecrets(text: string): void {
  for (const secret of SENSITIVE) {
    expect(text).not.toContain(secret);
  }
  expect(text.toLowerCase()).not.toContain('checksum');
}

function sessionStorageMock() {
  const storage = new Map<string, string>();
  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    _map: storage,
  };
}

function kiteSessionExchangeSuccess(): Response {
  return new Response(
    JSON.stringify({
      status: 'success',
      data: {
        user_id: KITE_USER_ID,
        user_name: 'Lifecycle User',
        access_token: ACCESS_TOKEN,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function kiteProfileSuccess(userId = KITE_USER_ID): Response {
  return new Response(
    JSON.stringify({
      status: 'success',
      data: {
        user_id: userId,
        user_name: 'Lifecycle User',
        email: 'user@example.com',
        broker: 'ZERODHA',
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('Kite auth lifecycle integration', () => {
  const fetchMock = vi.fn();
  let storage: ReturnType<typeof sessionStorageMock>;

  async function importRoutes() {
    const start = await import('@/app/api/kite/auth/start/route');
    const callback = await import('@/app/api/kite/auth/callback/route');
    const complete = await import('@/app/api/kite/auth/complete/route');
    const profile = await import('@/app/api/kite/profile/route');
    const session = await import('@/app/api/kite/session/route');
    const disconnect = await import('@/app/api/brokers/[broker]/disconnect/route');
    return { start, callback, complete, profile, session, disconnect };
  }

  async function importBrowserHelpers() {
    const browserSession = await import('@/lib/kite/browser-session');
    const fragment = await import('@/lib/kite/auth-complete-fragment');
    const redemption = await import('@/lib/kite/auth-complete-redemption');
    const connection = await import('@/lib/kite/browser-connection');
    return { browserSession, fragment, redemption, connection };
  }

  function installSameOriginBridge(routes: Awaited<ReturnType<typeof importRoutes>>) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.startsWith('https://api.kite.trade/')) {
        if (url.includes('/session/token') && (init?.method ?? 'GET') === 'POST') {
          return kiteSessionExchangeSuccess();
        }
        if (url.includes('/session/token') && (init?.method ?? 'GET') === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        if (url.includes('/user/profile')) {
          return kiteProfileSuccess();
        }
        return new Response(JSON.stringify({ status: 'error', error_type: 'GeneralException' }), {
          status: 500,
        });
      }

      if (url === '/api/kite/auth/complete' || url.endsWith('/api/kite/auth/complete')) {
        const request = new NextRequest('http://localhost/api/kite/auth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: typeof init?.body === 'string' ? init.body : undefined,
        });
        return routes.complete.POST(request);
      }

      if (url === '/api/kite/profile' || url.endsWith('/api/kite/profile')) {
        const request = new NextRequest('http://localhost/api/kite/profile', {
          method: 'GET',
        });
        return routes.profile.GET(request);
      }

      if (url === '/api/brokers/zerodha/disconnect' || url.endsWith('/api/brokers/zerodha/disconnect')) {
        const request = new NextRequest('http://localhost/api/brokers/zerodha/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
        });
        return routes.disconnect.POST(request, {
          params: Promise.resolve({ broker: 'zerodha' }),
        });
      }

      if (url === '/api/kite/session' || url.endsWith('/api/kite/session')) {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST') {
          const request = new NextRequest('http://localhost/api/kite/session', { method: 'POST' });
          return routes.session.POST(request);
        }
        const request = new NextRequest('http://localhost/api/kite/session', {
          method: 'DELETE',
        });
        return routes.session.DELETE(request);
      }

      throw new Error(`Unexpected fetch URL in lifecycle test: ${url}`);
    });
  }

  beforeEach(() => {
    vi.resetModules();
    fakeRedis.clear();
    redisClientRef.current = fakeRedis;
    activeSessionRef.current = null;
    mockRequireSession.mockReset();
    mockGetKiteConfig.mockReset();
    mockGetBrokerConnection.mockReset();
    mockGetDecrypted.mockReset();
    mockMarkStatus.mockReset();
    mockClearActive.mockReset();
    mockGetKiteConfig.mockReturnValue({ apiKey: API_KEY, apiSecret: API_SECRET });
    mockRequireSession.mockResolvedValue({ id: Number(USER_A) });
    mockGetBrokerConnection.mockResolvedValue({
      userId: Number(USER_A),
      status: 'active',
      accessTokenEncrypted: 'enc:cipher',
    });
    mockGetDecrypted.mockResolvedValue(null);
    mockMarkStatus.mockResolvedValue(undefined);
    mockClearActive.mockResolvedValue(true);
    process.env.KITE_API_KEY = API_KEY;
    process.env.KITE_API_SECRET = API_SECRET;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    storage = sessionStorageMock();
    vi.stubGlobal('window', {
      sessionStorage: storage,
      localStorage: sessionStorageMock(),
    });
  });

  afterEach(async () => {
    const { redemption } = await importBrowserHelpers();
    redemption.resetAuthCompleteRedemptionState();
    fakeRedis.clear();
    activeSessionRef.current = null;
    vi.unstubAllGlobals();
  });

  it('runs the successful authentication lifecycle end-to-end', async () => {
    const routes = await importRoutes();
    const helpers = await importBrowserHelpers();
    installSameOriginBridge(routes);

    const startResponse = await routes.start.GET();
    expect(startResponse.status).toBe(302);
    expect(startResponse.headers.get('Cache-Control')).toBe('no-store');

    const loginUrl = startResponse.headers.get('location')!;
    assertNoSecrets(loginUrl);
    const login = new URL(loginUrl);
    expect(login.origin).toBe('https://kite.zerodha.com');
    expect(login.pathname).toBe('/connect/login');
    expect(login.searchParams.get('api_key')).toBe(API_KEY);
    expect(login.searchParams.get('v')).toBe('3');
    const redirectParams = login.searchParams.get('redirect_params')!;
    const state = new URLSearchParams(redirectParams).get('state')!;
    expect(state.length).toBeGreaterThan(32);
    expect(fakeRedis.hasAuthStatePlaintext(state)).toBe(false);
    expect(fakeRedis.authStateCount()).toBe(1);

    const callbackResponse = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get('Cache-Control')).toBe('no-store');
    const completeLocation = callbackResponse.headers.get('location')!;
    assertNoSecrets(completeLocation);
    expect(completeLocation).toContain('#code=');
    expect(completeLocation).not.toContain('?code=');
    expect(completeLocation).not.toContain(REQUEST_TOKEN);
    expect(completeLocation).not.toContain(ACCESS_TOKEN);
    expect(fakeRedis.authStateCount()).toBe(0);
    expect(fakeRedis.completionCount()).toBe(1);

    const completeUrl = new URL(completeLocation);
    const fragmentCode = helpers.fragment.parseCompletionCodeFromHash(completeUrl.hash);
    expect(fragmentCode).toBeTruthy();
    const captured = helpers.redemption.resolveCompletionCode(fragmentCode);
    const stripped = helpers.fragment.stripCodeFragmentFromUrl(
      `http://localhost/kite/auth-complete?from=dashboard${completeUrl.hash}`,
    );
    expect(stripped).toBe('/kite/auth-complete?from=dashboard');
    expect(stripped).not.toContain(fragmentCode!);
    expect(helpers.redemption.resolveCompletionCode(null)).toBe(captured);

    const redeemResult = await helpers.redemption.redeemCompletionCode(captured!);
    expect(redeemResult).toEqual({
      ok: true,
      kiteUserId: KITE_USER_ID,
      authenticatedAt: expect.any(String),
    });
    expect(JSON.stringify(redeemResult)).not.toContain(ACCESS_TOKEN);
    expect(fakeRedis.completionCount()).toBe(0);

    expect(helpers.browserSession.getKiteSession()).toBeNull();
    expect(storage._map.has('quantorus:kite-session')).toBe(false);
    for (const value of storage._map.values()) {
      expect(value).not.toContain(ACCESS_TOKEN);
    }

    const replay = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: fragmentCode }),
      }),
    );
    expect(replay.status).toBe(401);
    expect(replay.headers.get('Cache-Control')).toBe('no-store');

    const verification = await helpers.connection.verifyKiteProfile();
    const connected = helpers.connection.resolveConnectedState(null, verification);
    expect(connected).toEqual({
      status: 'connected',
      userName: 'Lifecycle User',
      userId: KITE_USER_ID,
      broker: 'ZERODHA',
    });

    const profileCallsBefore = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      return url.includes('/api/kite/profile');
    }).length;
    expect(profileCallsBefore).toBe(1);
    const profileInit = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/kite/profile'))?.[1] as RequestInit;
    expect(new Headers(profileInit?.headers ?? {}).has('Authorization')).toBe(false);

    const disconnectPromise = helpers.connection.disconnectKiteSession();
    expect(helpers.browserSession.getKiteSession()).toBeNull();
    const disconnectOutcome = await disconnectPromise;
    expect(disconnectOutcome).toEqual({ kind: 'done' });

    const disconnectCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      const method = (call[1] as RequestInit | undefined)?.method;
      return url.includes('/api/brokers/zerodha/disconnect') && method === 'POST';
    });
    expect(disconnectCalls).toHaveLength(1);
    const disconnectInit = disconnectCalls[0]?.[1] as RequestInit;
    expect(new Headers(disconnectInit?.headers ?? {}).has('Authorization')).toBe(false);
  });

  it('rejects unauthenticated kite routes with 401 and no-store', async () => {
    const { AuthenticationError: AuthError } = await import('@/lib/errors');
    mockRequireSession.mockRejectedValue(new AuthError('Unauthorized'));
    const routes = await importRoutes();

    const start = await routes.start.GET();
    expect(start.status).toBe(401);
    expect(start.headers.get('Cache-Control')).toBe('no-store');

    const callback = await routes.callback.GET(
      new NextRequest('http://localhost/api/kite/auth/callback?status=success&request_token=r&state=s'),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('/login');

    const complete = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'x' }),
      }),
    );
    expect(complete.status).toBe(401);

    const profile = await routes.profile.GET(
      new NextRequest('http://localhost/api/kite/profile'),
    );
    expect(profile.status).toBe(401);

    const session = await routes.session.DELETE(
      new NextRequest('http://localhost/api/kite/session', {
        method: 'DELETE',
      }),
    );
    expect(session.status).toBe(401);
  });

  it('enforces user binding for state and completion codes', async () => {
    const routes = await importRoutes();
    installSameOriginBridge(routes);

    const start = await routes.start.GET();
    const state = new URLSearchParams(
      new URL(start.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;

    mockRequireSession.mockResolvedValue({ id: Number(USER_B) });
    const mismatchedCallback = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    expect(mismatchedCallback.status).toBe(302);
    expect(mismatchedCallback.headers.get('location')).toContain('/data-source');
    expect(mismatchedCallback.headers.get('location')).toContain('error=invalid_state');
    expect(fakeRedis.authStateCount()).toBe(1);
    expect(fakeRedis.completionCount()).toBe(0);

    mockRequireSession.mockResolvedValue({ id: Number(USER_A) });
    const ownedCallback = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    expect(ownedCallback.status).toBe(302);
    const code = new URL(ownedCallback.headers.get('location')!).hash.replace(/^#code=/, '');
    const decoded = decodeURIComponent(code);

    mockRequireSession.mockResolvedValue({ id: Number(USER_B) });
    const mismatchedComplete = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: decoded }),
      }),
    );
    expect(mismatchedComplete.status).toBe(401);
    expect(fakeRedis.completionCount()).toBe(1);

    mockRequireSession.mockResolvedValue({ id: Number(USER_A) });
    const ownedComplete = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: decoded }),
      }),
    );
    expect(ownedComplete.status).toBe(200);
    expect(fakeRedis.completionCount()).toBe(0);
    const completeBody = await ownedComplete.json();
    expect(completeBody).toEqual({
      ok: true,
      kiteUserId: KITE_USER_ID,
      authenticatedAt: expect.any(String),
    });
    expect(JSON.stringify(completeBody)).not.toContain(ACCESS_TOKEN);
  });

  it('rejects state and completion replay and expiry', async () => {
    const routes = await importRoutes();
    installSameOriginBridge(routes);

    const start = await routes.start.GET();
    const state = new URLSearchParams(
      new URL(start.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;

    const first = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    expect(first.status).toBe(302);
    const code = decodeURIComponent(
      new URL(first.headers.get('location')!).hash.replace(/^#code=/, ''),
    );

    const replayState = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    expect(replayState.status).toBe(302);
    expect(replayState.headers.get('location')).toContain('error=invalid_state');

    const firstRedeem = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
    );
    expect(firstRedeem.status).toBe(200);
    const replayCode = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
    );
    expect(replayCode.status).toBe(401);

    const startExpired = await routes.start.GET();
    const expiredState = new URLSearchParams(
      new URL(startExpired.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;
    fakeRedis.setNow(Date.now() + 11 * 60 * 1000);
    const expiredCallback = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${expiredState}`,
      ),
    );
    expect(expiredCallback.status).toBe(302);
    expect(expiredCallback.headers.get('location')).toContain('error=invalid_state');

    fakeRedis.setNow(Date.now());
    const startForCompletionExpiry = await routes.start.GET();
    const state2 = new URLSearchParams(
      new URL(startForCompletionExpiry.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;
    const callback2 = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state2}`,
      ),
    );
    const code2 = decodeURIComponent(
      new URL(callback2.headers.get('location')!).hash.replace(/^#code=/, ''),
    );
    fakeRedis.setNow(Date.now() + 61 * 1000);
    const expiredComplete = await routes.complete.POST(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code2 }),
      }),
    );
    expect(expiredComplete.status).toBe(401);
  });

  it('handles exchange and redis failures without leaking secrets', async () => {
    const routes = await importRoutes();

    const start = await routes.start.GET();
    const state = new URLSearchParams(
      new URL(start.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: 'error', error_type: 'TokenException', message: 'bad token' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const failedExchange = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    expect(failedExchange.status).toBe(302);
    expect(failedExchange.headers.get('location')).toContain('/data-source');
    expect(failedExchange.headers.get('location')).toContain('error=kite_token_exchange');
    expect(fakeRedis.completionCount()).toBe(0);
    assertNoSecrets(failedExchange.headers.get('location') ?? '');

    fakeRedis.failNextSet = true;
    const redisStart = await routes.start.GET();
    expect([500, 503]).toContain(redisStart.status);
    assertNoSecrets(await redisStart.text());

    const start2 = await routes.start.GET();
    const state2 = new URLSearchParams(
      new URL(start2.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;
    fetchMock.mockResolvedValueOnce(kiteSessionExchangeSuccess());
    fakeRedis.failNextEvalCreate = true;
    const failedCompletion = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state2}`,
      ),
    );
    expect(failedCompletion.status).toBe(302);
    expect(failedCompletion.headers.get('location')).toContain('/dashboard');
    expect(fakeRedis.completionCount()).toBe(0);
    assertNoSecrets(failedCompletion.headers.get('location') ?? '');
  });

  it('maps profile and disconnect failure modes safely', async () => {
    const routes = await importRoutes();
    const helpers = await importBrowserHelpers();
    const { REMOTE_INVALIDATION_WARNING } = await import('@/lib/kite/invalidate-remote-session');
    installSameOriginBridge(routes);

    activeSessionRef.current = {
      accessToken: ACCESS_TOKEN,
      kiteUserId: KITE_USER_ID,
      quantorusUserId: USER_A,
      authenticatedAt: new Date().toISOString(),
    };

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.startsWith('https://api.kite.trade/user/profile')) {
        return new Response(
          JSON.stringify({ status: 'error', error_type: 'TokenException', message: 'expired' }),
          { status: 403 },
        );
      }
      if (url.includes('/api/kite/profile')) {
        return routes.profile.GET(new NextRequest('http://localhost/api/kite/profile'));
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const unauthorized = await helpers.connection.verifyKiteProfile();
    const cleared = helpers.connection.resolveConnectedState(null, unauthorized);
    expect(cleared.status).toBe('verification_failed');
    expect(helpers.browserSession.getKiteSession()).toBeNull();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.startsWith('https://api.kite.trade/user/profile')) {
        return new Response('bad gateway', { status: 502 });
      }
      if (url.includes('/api/kite/profile')) {
        return routes.profile.GET(new NextRequest('http://localhost/api/kite/profile'));
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const temporary = await helpers.connection.verifyKiteProfile();
    const tempState = helpers.connection.resolveConnectedState(null, temporary);
    expect(tempState.status).toBe('temporary_failure');
    expect(helpers.browserSession.getKiteSession()).toBeNull();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.includes('/api/kite/profile')) {
        return Response.json({
          userId: KITE_USER_ID,
          userName: 'Lifecycle User',
          email: 'user@example.com',
          broker: 'ZERODHA',
          accessToken: ACCESS_TOKEN,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const tokenLeak = await helpers.connection.verifyKiteProfile();
    const leakState = helpers.connection.resolveConnectedState(null, tokenLeak);
    expect(leakState.status).toBe('verification_failed');
    expect(helpers.browserSession.getKiteSession()).toBeNull();

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.includes('/api/brokers/zerodha/disconnect')) {
        return new Response(null, { status: 502 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const disconnect = await helpers.connection.disconnectKiteSession();
    expect(helpers.browserSession.getKiteSession()).toBeNull();
    expect(disconnect).toEqual({ kind: 'done', warning: REMOTE_INVALIDATION_WARNING });
    if (disconnect.kind === 'done') {
      expect(disconnect.warning).not.toContain(ACCESS_TOKEN);
    }
  });

  it('deduplicates strict-mode redemption and issues a single broker disconnect', async () => {
    const routes = await importRoutes();
    const helpers = await importBrowserHelpers();
    installSameOriginBridge(routes);

    const start = await routes.start.GET();
    const state = new URLSearchParams(
      new URL(start.headers.get('location')!).searchParams.get('redirect_params')!,
    ).get('state')!;
    const callback = await routes.callback.GET(
      new NextRequest(
        `http://localhost/api/kite/auth/callback?status=success&request_token=${REQUEST_TOKEN}&state=${state}`,
      ),
    );
    const code = decodeURIComponent(
      new URL(callback.headers.get('location')!).hash.replace(/^#code=/, ''),
    );

    helpers.redemption.resolveCompletionCode(code);
    const first = helpers.redemption.redeemCompletionCode(code);
    const second = helpers.redemption.redeemCompletionCode(code);
    expect(first).toBe(second);
    expect(helpers.redemption.getInFlightRedemptionCount()).toBe(1);
    const redemptionResult = await first;
    expect(JSON.stringify(redemptionResult)).not.toContain(ACCESS_TOKEN);

    const completePosts = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/kite/auth/complete'));
    expect(completePosts).toHaveLength(1);

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.includes('/api/brokers/zerodha/disconnect')) {
        return Response.json({ ok: true, broker: 'zerodha', status: 'disconnected' });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await helpers.connection.disconnectKiteSession();
    expect(helpers.browserSession.getKiteSession()).toBeNull();

    const disconnectCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0]);
      return url.includes('/api/brokers/zerodha/disconnect')
        && (call[1] as RequestInit | undefined)?.method === 'POST';
    });
    expect(disconnectCalls).toHaveLength(1);
  });

  it('applies auth-complete security headers and rejects kite client redirects', async () => {
    const headers = new Headers();
    applySecurityHeaders(headers, {
      nonce: 'nonce',
      pathname: '/kite/auth-complete',
      isDev: false,
      isProduction: true,
    });
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(buildContentSecurityPolicy({
      nonce: 'nonce',
      pathname: '/kite/auth-complete',
      isDev: false,
      isProduction: true,
    })).toContain("frame-ancestors 'none'");

    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: 'https://evil.test/steal' },
    }));

    const { kiteAuthenticatedRequest } = await import('@/lib/kite/api-client');
    await expect(
      kiteAuthenticatedRequest({
        method: 'GET',
        path: '/user/profile',
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toMatchObject({
      message: 'Kite API redirect rejected',
    });
  });
});
