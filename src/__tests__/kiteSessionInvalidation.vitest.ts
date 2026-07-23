import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthenticationError } from '@/lib/errors';
import {
  clearKiteSession,
  getKiteSession,
} from '@/lib/kite/browser-session';
import {
  invalidateRemoteKiteSession,
  localDisconnectState,
  REMOTE_INVALIDATION_WARNING,
  shouldApplyVerificationResult,
} from '@/lib/kite/invalidate-remote-session';

vi.mock('server-only', () => ({}));

const {
  mockRequireSession,
  mockGetKiteConfig,
  mockGetActiveKiteSession,
  mockGetDecrypted,
  mockClearActive,
  mockMarkStatus,
  mockKiteAuthenticatedRequest,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockGetKiteConfig: vi.fn(),
  mockGetActiveKiteSession: vi.fn(),
  mockGetDecrypted: vi.fn(),
  mockClearActive: vi.fn(),
  mockMarkStatus: vi.fn(),
  mockKiteAuthenticatedRequest: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  requireSession: mockRequireSession,
}));

vi.mock('@/lib/kite/config', () => ({
  getKiteConfig: mockGetKiteConfig,
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  clearActiveKiteSession: mockClearActive,
  getActiveKiteSession: mockGetActiveKiteSession,
  saveActiveKiteSession: vi.fn(),
}));

vi.mock('@/lib/broker/connections', () => ({
  getDecryptedAccessTokenForUser: mockGetDecrypted,
  markBrokerConnectionStatus: mockMarkStatus,
}));

vi.mock('@/lib/kite/api-client', () => ({
  kiteAuthenticatedRequest: mockKiteAuthenticatedRequest,
  isKiteInvalidToken: (response: { httpStatus?: number; kiteStatus?: string; body?: unknown }) => {
    if (response.httpStatus === 403 || response.httpStatus === 404) return true;
    if (
      response.body
      && typeof response.body === 'object'
      && !Array.isArray(response.body)
      && (response.body as { error_type?: string }).error_type === 'TokenException'
    ) {
      return true;
    }
    return false;
  },
  KiteApiError: class KiteApiError extends Error {
    classification: string;
    constructor(message: string, opts?: { classification?: string }) {
      super(message);
      this.classification = opts?.classification ?? 'network';
    }
  },
}));

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({
    getAccessToken: () => 'kite-access-token',
    setAccessToken: vi.fn(),
  }),
  resetKiteClient: vi.fn(),
}));

import { DELETE } from '@/app/api/kite/session/route';

function makeDeleteRequest(): NextRequest {
  return new NextRequest('http://localhost/api/kite/session', {
    method: 'DELETE',
  });
}

describe('DELETE /api/kite/session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ id: 42 });
    mockGetKiteConfig.mockReturnValue({ apiKey: 'test-api-key', apiSecret: 'secret' });
    mockGetActiveKiteSession.mockResolvedValue({
      quantorusUserId: '42',
      kiteUserId: 'AB1234',
      accessToken: 'kite-access-token',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockClearActive.mockResolvedValue(true);
    mockMarkStatus.mockResolvedValue(undefined);
    mockKiteAuthenticatedRequest.mockResolvedValue({
      empty: false,
      httpStatus: 204,
      kiteStatus: 'success',
      body: { status: 'success' },
    });
  });

  it('invalidates a Kite session using server-side credentials without browser Bearer', async () => {
    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    expect(mockKiteAuthenticatedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        path: '/session/token',
        accessToken: 'kite-access-token',
        credentialMode: 'form',
      }),
    );
    expect(mockClearActive).toHaveBeenCalledWith('kite-access-token');
    expect(mockMarkStatus).toHaveBeenCalledWith(42, 'zerodha', 'disconnected', true);

    const body = await response.text();
    expect(body).toBe('');
  });

  it('treats missing server-side credentials as idempotent success', async () => {
    mockGetActiveKiteSession.mockResolvedValue(null);
    mockGetDecrypted.mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(204);
    expect(mockKiteAuthenticatedRequest).not.toHaveBeenCalled();
    expect(mockClearActive).toHaveBeenCalled();
    expect(mockMarkStatus).toHaveBeenCalledWith(42, 'zerodha', 'disconnected', true);
  });

  it('treats an already-invalid Kite token as idempotent success', async () => {
    mockKiteAuthenticatedRequest.mockResolvedValue({
      empty: false,
      httpStatus: 403,
      kiteStatus: 'error',
      body: {
        status: 'error',
        error_type: 'TokenException',
        message: 'Invalid session',
      },
    });

    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('maps upstream failures to 502', async () => {
    mockKiteAuthenticatedRequest.mockResolvedValue({
      empty: false,
      httpStatus: 500,
      kiteStatus: 'error',
      body: {
        status: 'error',
        error_type: 'GeneralException',
        message: 'Upstream failure',
      },
    });

    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(502);

    const payload = await response.json();
    expect(payload).toEqual({
      ok: false,
      error: 'Kite session invalidation failed',
    });
  });

  it('maps Kite configuration failure to 503', async () => {
    const { KiteApiError } = await import('@/lib/kite/api-client');
    mockKiteAuthenticatedRequest.mockRejectedValue(
      new KiteApiError('Missing KITE_API_KEY', { status: 503, classification: 'configuration' }),
    );

    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(503);
  });

  it('maps Quantorus authentication failure to 401', async () => {
    mockRequireSession.mockRejectedValue(new AuthenticationError('Unauthorized'));

    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(401);
    expect(mockKiteAuthenticatedRequest).not.toHaveBeenCalled();
  });

  it('maps network failures to 502', async () => {
    const { KiteApiError } = await import('@/lib/kite/api-client');
    mockKiteAuthenticatedRequest.mockRejectedValue(
      new KiteApiError('Unable to reach Kite API', { status: 502, classification: 'network' }),
    );

    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(502);

    const payload = await response.json();
    expect(payload.error).toBe('Unable to reach Kite API');
  });
});

describe('Kite disconnect client helpers', () => {
  const fetchMock = vi.fn();
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears local legacy storage immediately even when remote invalidation fails', async () => {
    storage.set(
      'quantorus:kite-session',
      JSON.stringify({ accessToken: 'local-token', kiteUserId: 'AB1234' }),
    );
    clearKiteSession();

    expect(getKiteSession()).toBeNull();
    expect(storage.has('quantorus:kite-session')).toBe(false);

    fetchMock.mockRejectedValue(new Error('network down'));
    const remoteInvalidationConfirmed = await invalidateRemoteKiteSession();

    expect(remoteInvalidationConfirmed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/brokers/zerodha/disconnect',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(getKiteSession()).toBeNull();
    expect(localDisconnectState(remoteInvalidationConfirmed)).toEqual({
      status: 'not_connected',
      remoteInvalidationWarning: REMOTE_INVALIDATION_WARNING,
    });
  });

  it('ignores stale verification responses after disconnect', () => {
    const verificationGeneration = 1;
    const currentGenerationAfterDisconnect = 2;

    expect(
      shouldApplyVerificationResult(
        verificationGeneration,
        currentGenerationAfterDisconnect,
      ),
    ).toBe(false);
  });

  it('reports remote invalidation success without a warning', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(invalidateRemoteKiteSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/brokers/zerodha/disconnect',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(localDisconnectState(true)).toEqual({ status: 'not_connected' });
  });
});
