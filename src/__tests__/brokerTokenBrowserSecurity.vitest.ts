/**
 * Security regression tests: broker access tokens must never reach the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

const {
  mockRequireSession,
  mockConsumeCompletion,
  mockGetActiveKiteSession,
  mockGetBrokerConnection,
  mockGetDecrypted,
  mockMarkStatus,
  mockClearActive,
  mockKiteAuthenticatedRequest,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockConsumeCompletion: vi.fn(),
  mockGetActiveKiteSession: vi.fn(),
  mockGetBrokerConnection: vi.fn(),
  mockGetDecrypted: vi.fn(),
  mockMarkStatus: vi.fn(),
  mockClearActive: vi.fn(),
  mockKiteAuthenticatedRequest: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  requireSession: mockRequireSession,
}));

vi.mock('@/lib/kite/completion-store', () => ({
  consumeKiteCompletionCode: mockConsumeCompletion,
  createKiteCompletionCode: vi.fn(),
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  getActiveKiteSession: mockGetActiveKiteSession,
  clearActiveKiteSession: mockClearActive,
  saveActiveKiteSession: vi.fn(),
}));

vi.mock('@/lib/broker/connections', () => ({
  getBrokerConnectionByUserAndBroker: mockGetBrokerConnection,
  getDecryptedAccessTokenForUser: mockGetDecrypted,
  markBrokerConnectionStatus: mockMarkStatus,
}));

vi.mock('@/lib/kite/api-client', () => ({
  kiteAuthenticatedRequest: mockKiteAuthenticatedRequest,
  isKiteInvalidToken: () => false,
  KiteApiError: class KiteApiError extends Error {
    classification = 'network';
  },
}));

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({ getAccessToken: () => null, setAccessToken: vi.fn() }),
  resetKiteClient: vi.fn(),
}));

import { POST as completeAuth } from '@/app/api/kite/auth/complete/route';
import { GET as getProfile } from '@/app/api/kite/profile/route';
import { POST as postSession, DELETE as deleteSession } from '@/app/api/kite/session/route';
import {
  clearKiteSession,
  getKiteAccessToken,
  getKiteSession,
  saveKiteSession,
} from '@/lib/kite/browser-session';
import {
  redeemCompletionCode,
  resetAuthCompleteRedemptionState,
} from '@/lib/kite/auth-complete-redemption';

const LEGACY_KEY = 'quantorus:kite-session';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    _map: map,
  };
}

describe('broker token browser exposure security regressions', () => {
  let sessionStorage: ReturnType<typeof makeStorage>;
  let localStorage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAuthCompleteRedemptionState();
    sessionStorage = makeStorage();
    localStorage = makeStorage();
    vi.stubGlobal('window', { sessionStorage, localStorage });
    mockRequireSession.mockResolvedValue({ id: 42 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /api/kite/auth/complete never returns an access token', async () => {
    mockConsumeCompletion.mockResolvedValue({
      kiteUserId: 'AB1234',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockGetActiveKiteSession.mockResolvedValue({
      quantorusUserId: '42',
      kiteUserId: 'AB1234',
      accessToken: 'server-only-secret-token',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockGetBrokerConnection.mockResolvedValue({
      status: 'active',
      accessTokenEncrypted: 'brk1:cipher',
    });

    const response = await completeAuth(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        body: JSON.stringify({ code: 'opaque-code' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      kiteUserId: 'AB1234',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toMatch(/access[_]?token|server-only-secret/i);
  });

  it('rejects cross-user completion redemption', async () => {
    mockConsumeCompletion.mockResolvedValue(null);

    const response = await completeAuth(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        body: JSON.stringify({ code: 'other-user-code' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(response.status).toBe(401);
    expect(mockConsumeCompletion).toHaveBeenCalledWith('other-user-code', '42');
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/access[_]?token/i);
  });

  it('rejects duplicate completion redemption', async () => {
    mockConsumeCompletion
      .mockResolvedValueOnce({
        kiteUserId: 'AB1234',
        authenticatedAt: '2026-01-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce(null);
    mockGetActiveKiteSession.mockResolvedValue({
      quantorusUserId: '42',
      kiteUserId: 'AB1234',
      accessToken: 'tok',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });

    const first = await completeAuth(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        body: JSON.stringify({ code: 'once' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const second = await completeAuth(
      new NextRequest('http://localhost/api/kite/auth/complete', {
        method: 'POST',
        body: JSON.stringify({ code: 'once' }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('auth-complete page redemption rejects token material in API responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            kiteUserId: 'AB1234',
            accessToken: 'leaked-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await redeemCompletionCode('code-1');
    expect(result).toEqual({
      ok: false,
      message: 'Invalid session data received. Please try again.',
    });
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('auth-complete redemption never writes tokens to browser storage', async () => {
    sessionStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ accessToken: 'legacy-token', kiteUserId: 'OLD' }),
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            kiteUserId: 'AB1234',
            authenticatedAt: '2026-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await redeemCompletionCode('code-2');
    expect(result.ok).toBe(true);
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(getKiteAccessToken()).toBeNull();
    expect(getKiteSession()).toBeNull();
  });

  it('browser session helpers never persist access tokens', () => {
    saveKiteSession({
      kiteUserId: 'AB1234',
      accessToken: 'must-not-persist',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(getKiteAccessToken()).toBeNull();
    clearKiteSession();
    expect(sessionStorage._map.size).toBe(0);
  });

  it('GET /api/kite/profile uses server-side credentials, not browser Bearer', async () => {
    mockGetActiveKiteSession.mockResolvedValue({
      quantorusUserId: '42',
      kiteUserId: 'AB1234',
      accessToken: 'server-token',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockKiteAuthenticatedRequest.mockResolvedValue({
      empty: false,
      httpStatus: 200,
      kiteStatus: 'success',
      body: {
        status: 'success',
        data: {
          user_id: 'AB1234',
          user_name: 'Test User',
          email: 't@example.com',
          broker: 'ZERODHA',
        },
      },
    });

    const response = await getProfile(
      new NextRequest('http://localhost/api/kite/profile', {
        headers: { Authorization: 'Bearer browser-supplied-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockKiteAuthenticatedRequest).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'server-token' }),
    );
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/server-token|browser-supplied/i);
  });

  it('POST /api/kite/session rejects browser token handoff', async () => {
    const response = await postSession(
      new NextRequest('http://localhost/api/kite/session', {
        method: 'POST',
        headers: { Authorization: 'Bearer browser-token' },
      }),
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toMatch(/browser-token/i);
  });

  it('DELETE /api/kite/session clears server-side broker state without Bearer', async () => {
    mockGetActiveKiteSession.mockResolvedValue({
      quantorusUserId: '42',
      kiteUserId: 'AB1234',
      accessToken: 'server-token',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockKiteAuthenticatedRequest.mockResolvedValue({
      empty: false,
      httpStatus: 200,
      kiteStatus: 'success',
      body: { status: 'success' },
    });
    mockClearActive.mockResolvedValue(true);
    mockMarkStatus.mockResolvedValue(undefined);

    const response = await deleteSession(
      new NextRequest('http://localhost/api/kite/session', { method: 'DELETE' }),
    );

    expect(response.status).toBe(204);
    expect(mockClearActive).toHaveBeenCalled();
    expect(mockMarkStatus).toHaveBeenCalledWith(42, 'zerodha', 'disconnected', true);
  });

  it('client components under src/app do not write broker access tokens to storage', () => {
    const roots = [
      join(process.cwd(), 'src/app'),
      join(process.cwd(), 'src/lib/kite'),
    ];
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(name)) continue;
        const src = readFileSync(full, 'utf8');
        if (/sessionStorage\.setItem\([^)]*accessToken/i.test(src)) {
          offenders.push(full);
        }
        if (/localStorage\.setItem\([^)]*accessToken/i.test(src)) {
          offenders.push(full);
        }
        // Writing JSON that includes accessToken into session/local storage
        if (
          /(session|local)Storage\.setItem\([\s\S]{0,200}accessToken/i.test(src)
          && !full.includes('browser-session.ts')
        ) {
          offenders.push(full);
        }
      }
    }

    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
