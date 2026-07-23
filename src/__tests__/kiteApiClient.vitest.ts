import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthenticationError } from '@/lib/errors';
import { KiteConfigError } from '@/lib/kite/errors';

vi.mock('server-only', () => ({}));

const { mockGetKiteConfig, mockRequireSession } = vi.hoisted(() => ({
  mockGetKiteConfig: vi.fn(),
  mockRequireSession: vi.fn(),
}));

vi.mock('@/lib/kite/config', () => ({
  getKiteConfig: mockGetKiteConfig,
}));

vi.mock('@/lib/session', () => ({
  requireSession: mockRequireSession,
}));

const {
  mockGetActiveKiteSession,
  mockGetDecrypted,
  mockClearActive,
  mockMarkStatus,
} = vi.hoisted(() => ({
  mockGetActiveKiteSession: vi.fn(),
  mockGetDecrypted: vi.fn(),
  mockClearActive: vi.fn(),
  mockMarkStatus: vi.fn(),
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  getActiveKiteSession: mockGetActiveKiteSession,
  clearActiveKiteSession: mockClearActive,
  saveActiveKiteSession: vi.fn(),
}));

vi.mock('@/lib/broker/connections', () => ({
  getDecryptedAccessTokenForUser: mockGetDecrypted,
  markBrokerConnectionStatus: mockMarkStatus,
}));

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({
    getAccessToken: () => ACCESS_TOKEN,
    setAccessToken: vi.fn(),
  }),
  resetKiteClient: vi.fn(),
}));

import {
  classifyKiteApiResponse,
  isKiteInvalidToken,
  isKiteRateLimited,
  kiteAuthenticatedRequest,
  KITE_API_BASE_URL,
  KiteApiError,
  validateKiteApiPath,
} from '@/lib/kite/api-client';
import { GET as getKiteProfile } from '@/app/api/kite/profile/route';
import { DELETE as deleteKiteSession } from '@/app/api/kite/session/route';

const API_KEY = 'test-api-key';
const ACCESS_TOKEN = 'kite-access-token';

function profileSuccessBody() {
  return {
    status: 'success',
    data: {
      user_id: 'AB1234',
      user_name: 'Test User',
      email: 'user@example.com',
      broker: 'ZERODHA',
    },
  };
}

describe('kite api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKiteConfig.mockReturnValue({ apiKey: API_KEY, apiSecret: 'secret' });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends authenticated headers against the fixed Kite origin', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(profileSuccessBody()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken: ACCESS_TOKEN,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${KITE_API_BASE_URL}/user/profile`,
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        headers: expect.any(Headers),
      }),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('X-Kite-Version')).toBe('3');
    expect(headers.get('Authorization')).toBe(`token ${API_KEY}:${ACCESS_TOKEN}`);
  });

  it('sends form credentials for session invalidation', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await kiteAuthenticatedRequest({
      method: 'DELETE',
      path: '/session/token',
      accessToken: ACCESS_TOKEN,
      credentialMode: 'form',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe(`api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`);
  });

  it.each([
    'user/profile',
    'https://evil.test/user/profile',
    '//evil.test/user/profile',
    '/user/profile#fragment',
    '/user\\profile',
    '/user@profile',
  ])('rejects unsafe path %s', async (path) => {
    await expect(
      kiteAuthenticatedRequest({
        method: 'GET',
        path,
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toMatchObject({
      classification: 'invalid_response',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns profile success payloads', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(profileSuccessBody()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken: ACCESS_TOKEN,
    });

    expect(classifyKiteApiResponse(response)).toBe('success');
    expect(response.body).toEqual(profileSuccessBody());
  });

  it('handles empty 204 success responses', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await kiteAuthenticatedRequest({
      method: 'DELETE',
      path: '/session/token',
      accessToken: ACCESS_TOKEN,
      credentialMode: 'form',
    });

    expect(response.empty).toBe(true);
    expect(response.httpStatus).toBe(204);
    expect(classifyKiteApiResponse(response)).toBe('success');
  });

  it('classifies invalid token responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error_type: 'TokenException',
          message: 'Invalid session',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken: ACCESS_TOKEN,
    });

    expect(isKiteInvalidToken(response)).toBe(true);
    expect(classifyKiteApiResponse(response)).toBe('invalid_token');
  });

  it('classifies rate-limit responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error_type: 'RateLimitException',
          message: 'Too many requests',
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken: ACCESS_TOKEN,
    });

    expect(isKiteRateLimited(response)).toBe(true);
    expect(classifyKiteApiResponse(response)).toBe('rate_limited');
  });

  it('throws on malformed JSON for non-success HTTP responses', async () => {
    fetchMock.mockResolvedValue(new Response('not-json', { status: 500 }));

    await expect(
      kiteAuthenticatedRequest({
        method: 'GET',
        path: '/user/profile',
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toMatchObject({
      classification: 'invalid_response',
      status: 502,
    });
  });

  it('classifies upstream 5xx responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error_type: 'GeneralException',
          message: 'Server error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken: ACCESS_TOKEN,
    });

    expect(classifyKiteApiResponse(response)).toBe('upstream');
  });

  it('throws on upstream timeouts', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }));

    await expect(
      kiteAuthenticatedRequest({
        method: 'GET',
        path: '/user/profile',
        accessToken: ACCESS_TOKEN,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      classification: 'network',
      message: 'Kite API request timed out',
    });
  });

  it('throws on network failures', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(
      kiteAuthenticatedRequest({
        method: 'GET',
        path: '/user/profile',
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toMatchObject({
      classification: 'network',
      message: 'Unable to reach Kite API',
    });
  });

  it('rejects external redirects', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.test/steal' },
      }),
    );

    await expect(
      kiteAuthenticatedRequest({
        method: 'GET',
        path: '/user/profile',
        accessToken: ACCESS_TOKEN,
      }),
    ).rejects.toMatchObject({
      classification: 'upstream',
      message: 'Kite API redirect rejected',
    });
  });

  it('never includes secrets in thrown errors', async () => {
    mockGetKiteConfig.mockImplementation(() => {
      throw new KiteConfigError('Missing KITE_API_KEY');
    });

    try {
      await kiteAuthenticatedRequest({
        method: 'GET',
        path: '/user/profile',
        accessToken: ACCESS_TOKEN,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(KiteApiError);
      const message = (err as KiteApiError).message;
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(ACCESS_TOKEN);
      expect(message).not.toContain('token ');
    }
  });

  it('validates paths through validateKiteApiPath', () => {
    expect(validateKiteApiPath('/user/profile')).toBe('/user/profile');
    expect(() => validateKiteApiPath('https://evil.test/profile')).toThrow(KiteApiError);
  });
});

describe('kite routes using api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ id: 42 });
    mockGetKiteConfig.mockReturnValue({ apiKey: API_KEY, apiSecret: 'secret' });
    mockGetActiveKiteSession.mockResolvedValue({
      quantorusUserId: '42',
      kiteUserId: 'AB1234',
      accessToken: ACCESS_TOKEN,
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockGetDecrypted.mockResolvedValue(null);
    mockClearActive.mockResolvedValue(true);
    mockMarkStatus.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps profile route success behavior', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(profileSuccessBody()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = new NextRequest('http://localhost/api/kite/profile', {
      headers: { Authorization: 'Bearer browser-supplied-token' },
    });
    const response = await getKiteProfile(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      userId: 'AB1234',
      userName: 'Test User',
      email: 'user@example.com',
      broker: 'ZERODHA',
      kiteUserId: 'AB1234',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`token ${API_KEY}:${ACCESS_TOKEN}`);
    expect(headers.get('Authorization')).not.toContain('browser-supplied-token');
  });

  it('keeps profile invalid-token mapping', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error_type: 'TokenException',
          message: 'Invalid session',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const request = new NextRequest('http://localhost/api/kite/profile');
    const response = await getKiteProfile(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Invalid or expired Kite access token',
    });
  });

  it('keeps session invalidation success and idempotent token behavior without browser Bearer', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const successRequest = new NextRequest('http://localhost/api/kite/session', {
      method: 'DELETE',
    });
    const successResponse = await deleteKiteSession(successRequest);
    expect(successResponse.status).toBe(204);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(`api_key=${API_KEY}&access_token=${ACCESS_TOKEN}`);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'error',
          error_type: 'TokenException',
          message: 'Invalid session',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const idempotentRequest = new NextRequest('http://localhost/api/kite/session', {
      method: 'DELETE',
    });
    const idempotentResponse = await deleteKiteSession(idempotentRequest);
    expect(idempotentResponse.status).toBe(204);
  });

  it('maps configuration failures to 503', async () => {
    mockGetKiteConfig.mockImplementation(() => {
      throw new KiteConfigError('Missing KITE_API_KEY');
    });

    const request = new NextRequest('http://localhost/api/kite/profile');
    const response = await getKiteProfile(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Kite is not configured',
    });
  });

  it('maps Quantorus auth failures to 401', async () => {
    mockRequireSession.mockRejectedValue(new AuthenticationError('Unauthorized'));

    const request = new NextRequest('http://localhost/api/kite/profile');
    const response = await getKiteProfile(request);

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
