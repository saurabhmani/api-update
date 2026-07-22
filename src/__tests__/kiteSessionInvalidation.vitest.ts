import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthenticationError } from '@/lib/errors';
import { KiteConfigError } from '@/lib/kite/errors';
import {
  clearKiteSession,
  getKiteSession,
  saveKiteSession,
} from '@/lib/kite/browser-session';
import {
  invalidateRemoteKiteSession,
  localDisconnectState,
  REMOTE_INVALIDATION_WARNING,
  shouldApplyVerificationResult,
} from '@/lib/kite/invalidate-remote-session';

vi.mock('server-only', () => ({}));

const { mockRequireSession, mockGetKiteConfig } = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockGetKiteConfig: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  requireSession: mockRequireSession,
}));

vi.mock('@/lib/kite/config', () => ({
  getKiteConfig: mockGetKiteConfig,
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  clearActiveKiteSession: vi.fn().mockResolvedValue(true),
  saveActiveKiteSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({
    getAccessToken: () => '',
    setAccessToken: vi.fn(),
  }),
  resetKiteClient: vi.fn(),
}));

import { DELETE } from '@/app/api/kite/session/route';

function makeDeleteRequest(accessToken?: string): NextRequest {
  const headers = new Headers();
  if (accessToken !== undefined) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return new NextRequest('http://localhost/api/kite/session', {
    method: 'DELETE',
    headers,
  });
}

describe('DELETE /api/kite/session', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ id: 42 });
    mockGetKiteConfig.mockReturnValue({ apiKey: 'test-api-key', apiSecret: 'secret' });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('invalidates a Kite session successfully', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    const response = await DELETE(makeDeleteRequest('kite-access-token'));
    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kite.trade/session/token',
      expect.objectContaining({
        method: 'DELETE',
        cache: 'no-store',
        redirect: 'manual',
        body: 'api_key=test-api-key&access_token=kite-access-token',
      }),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get('X-Kite-Version')).toBe('3');
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');

    const body = await response.text();
    expect(body).toBe('');
  });

  it('rejects a missing bearer token with 401', async () => {
    const response = await DELETE(makeDeleteRequest());
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    const payload = await response.json();
    expect(payload).toEqual({
      ok: false,
      error: 'Kite access token is required',
    });
  });

  it('treats an already-invalid Kite token as idempotent success', async () => {
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

    const response = await DELETE(makeDeleteRequest('expired-token'));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('maps upstream failures to 502', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          error_type: 'GeneralException',
          message: 'Upstream failure',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const response = await DELETE(makeDeleteRequest('kite-access-token'));
    expect(response.status).toBe(502);

    const payload = await response.json();
    expect(payload).toEqual({
      ok: false,
      error: 'Kite session invalidation failed',
    });
  });

  it('maps Kite configuration failure to 503', async () => {
    mockGetKiteConfig.mockImplementation(() => {
      throw new KiteConfigError('Missing KITE_API_KEY');
    });

    const response = await DELETE(makeDeleteRequest('kite-access-token'));
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps Quantorus authentication failure to 401', async () => {
    mockRequireSession.mockRejectedValue(new AuthenticationError('Unauthorized'));

    const response = await DELETE(makeDeleteRequest('kite-access-token'));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps network failures to 502', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const response = await DELETE(makeDeleteRequest('kite-access-token'));
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears local session immediately even when remote invalidation fails', async () => {
    saveKiteSession({
      accessToken: 'local-token',
      kiteUserId: 'AB1234',
      authenticatedAt: new Date().toISOString(),
    });

    const capturedAccessToken = getKiteSession()?.accessToken ?? '';
    clearKiteSession();

    expect(getKiteSession()).toBeNull();
    expect(capturedAccessToken).toBe('local-token');

    fetchMock.mockRejectedValue(new Error('network down'));
    const remoteInvalidationConfirmed = await invalidateRemoteKiteSession(capturedAccessToken);

    expect(remoteInvalidationConfirmed).toBe(false);
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
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(invalidateRemoteKiteSession('token')).resolves.toBe(true);
    expect(localDisconnectState(true)).toEqual({ status: 'not_connected' });
  });
});
