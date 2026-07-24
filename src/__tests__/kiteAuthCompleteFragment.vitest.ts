import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  getInFlightRedemptionCount,
  hasCapturedCompletionCode,
  isRedemptionInFlight,
  redeemCompletionCode,
  resetAuthCompleteRedemptionState,
  resolveCompletionCode,
} from '@/lib/kite/auth-complete-redemption';
import {
  buildAuthCompleteRedirectUrl,
  parseCompletionCodeFromHash,
  stripCodeFragmentFromUrl,
} from '@/lib/kite/auth-complete-fragment';

vi.mock('server-only', () => ({}));

const {
  mockRequireSession,
  mockConsumeKiteAuthState,
  mockCreateKiteSession,
  mockCreateKiteCompletionCode,
} = vi.hoisted(() => ({
  mockRequireSession: vi.fn(),
  mockConsumeKiteAuthState: vi.fn(),
  mockCreateKiteSession: vi.fn(),
  mockCreateKiteCompletionCode: vi.fn(),
}));

vi.mock('@/lib/session', () => ({
  requireSession: mockRequireSession,
}));

vi.mock('@/lib/kite/auth-state', () => ({
  consumeKiteAuthState: mockConsumeKiteAuthState,
}));

vi.mock('@/lib/kite/create-session', () => ({
  createKiteSession: mockCreateKiteSession,
  KiteSessionError: class KiteSessionError extends Error {
    status = 502;
  },
}));

vi.mock('@/lib/kite/completion-store', () => ({
  createKiteCompletionCode: mockCreateKiteCompletionCode,
}));

vi.mock('@/lib/kite/browser-session', () => ({
  saveKiteSession: vi.fn(),
}));

vi.mock('@/lib/kite/active-session-store', () => ({
  saveActiveKiteSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/kite/client', () => ({
  getKiteClient: () => ({ setAccessToken: vi.fn() }),
}));

vi.mock('@/lib/broker/oauth/zerodhaBridge', () => ({
  persistZerodhaBrokerConnection: vi.fn().mockResolvedValue(undefined),
}));

import { GET } from '@/app/api/kite/auth/callback/route';
import { resolveAuthCompleteOrigin } from '@/lib/kite/auth-complete-fragment';

function makeCallbackRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/kite/auth/callback?${query}`);
}

const ORIGIN_ENV_KEYS = ['APP_URL', 'NEXT_PUBLIC_APP_URL', 'KITE_REDIRECT_URL'] as const;

function clearOriginEnv(): void {
  for (const key of ORIGIN_ENV_KEYS) delete process.env[key];
}

describe('GET /api/kite/auth/callback redirect', () => {
  const previousEnv = Object.fromEntries(
    ORIGIN_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    clearOriginEnv();
    mockRequireSession.mockResolvedValue({ id: 42 });
    mockConsumeKiteAuthState.mockResolvedValue(true);
    mockCreateKiteSession.mockResolvedValue({
      userId: 'AB1234',
      accessToken: 'kite-access-token',
    });
    mockCreateKiteCompletionCode.mockResolvedValue('completion-code-123');
  });

  afterEach(() => {
    clearOriginEnv();
    for (const key of ORIGIN_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('redirects with a fragment code and no query-string code', async () => {
    const response = await GET(
      makeCallbackRequest('status=success&request_token=req-token&state=csrf-state'),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toBe(buildAuthCompleteRedirectUrl('http://localhost:3000', 'completion-code-123'));
    expect(location).not.toContain('?code=');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('uses APP_URL when request origin is the proxy loopback', async () => {
    process.env.APP_URL = 'https://quantorus.in/';

    const response = await GET(
      new NextRequest(
        'https://localhost:5000/api/kite/auth/callback?status=success&request_token=req-token&state=csrf-state',
        {
          headers: {
            'x-forwarded-host': 'quantorus.in',
            'x-forwarded-proto': 'https',
          },
        },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      buildAuthCompleteRedirectUrl('https://quantorus.in', 'completion-code-123'),
    );
  });

  it('uses X-Forwarded-Host when env URLs are loopback', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://localhost:5000';
    process.env.KITE_REDIRECT_URL = 'https://localhost:5000/api/kite/auth/callback';

    const response = await GET(
      new NextRequest(
        'https://localhost:5000/api/kite/auth/callback?status=success&request_token=req-token&state=csrf-state',
        {
          headers: {
            'x-forwarded-host': 'quantorus.in',
            'x-forwarded-proto': 'https',
          },
        },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      buildAuthCompleteRedirectUrl('https://quantorus.in', 'completion-code-123'),
    );
  });

  it('URL-encodes special characters in the fragment code', async () => {
    const specialCode = 'a+b=c&d/e';
    mockCreateKiteCompletionCode.mockResolvedValue(specialCode);

    const response = await GET(
      makeCallbackRequest('status=success&request_token=req-token&state=csrf-state'),
    );

    const location = response.headers.get('location');
    expect(location).toBe(buildAuthCompleteRedirectUrl('http://localhost:3000', specialCode));
    expect(parseCompletionCodeFromHash(new URL(location!).hash)).toBe(specialCode);
  });
});

describe('resolveAuthCompleteOrigin', () => {
  const previousEnv = Object.fromEntries(
    ORIGIN_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  afterEach(() => {
    clearOriginEnv();
    for (const key of ORIGIN_ENV_KEYS) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers public APP_URL over loopback request origin', () => {
    process.env.APP_URL = 'https://quantorus.in/';
    expect(resolveAuthCompleteOrigin('https://localhost:5000')).toBe('https://quantorus.in');
  });

  it('skips loopback NEXT_PUBLIC_APP_URL in favor of KITE_REDIRECT_URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://localhost:5000';
    process.env.KITE_REDIRECT_URL = 'https://quantorus.in/api/kite/auth/callback';
    expect(resolveAuthCompleteOrigin('https://localhost:5000')).toBe('https://quantorus.in');
  });

  it('falls back to request origin when unset', () => {
    clearOriginEnv();
    expect(resolveAuthCompleteOrigin('https://localhost:5000')).toBe('https://localhost:5000');
  });
});

describe('auth-complete fragment handling', () => {
  beforeEach(() => {
    resetAuthCompleteRedemptionState();
  });

  afterEach(() => {
    resetAuthCompleteRedemptionState();
    vi.unstubAllGlobals();
  });

  it('parses and trims the completion code from the fragment', () => {
    expect(parseCompletionCodeFromHash('#code=abc123')).toBe('abc123');
    expect(parseCompletionCodeFromHash('#code=%20trimmed%20')).toBe('trimmed');
  });

  it('rejects missing or blank fragment codes', () => {
    expect(parseCompletionCodeFromHash('')).toBeNull();
    expect(parseCompletionCodeFromHash('#')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=%20%20')).toBeNull();
    expect(parseCompletionCodeFromHash('#other=value')).toBeNull();
  });

  it('rejects duplicate code parameters instead of selecting the first value', () => {
    expect(parseCompletionCodeFromHash('#code=first&code=second')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=abc&code=abc')).toBeNull();
  });

  it('rejects duplicate blank and non-blank code combinations', () => {
    expect(parseCompletionCodeFromHash('#code=&code=abc')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=abc&code=')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=%20&code=abc')).toBeNull();
  });

  it('rejects malformed percent encoding in the fragment', () => {
    expect(parseCompletionCodeFromHash('#code=%')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=%GG')).toBeNull();
    expect(parseCompletionCodeFromHash('#code=abc%2')).toBeNull();
  });

  it('accepts correctly encoded special characters', () => {
    expect(parseCompletionCodeFromHash('#code=a%2Bb%3Dc%26d%2Fe')).toBe('a+b=c&d/e');
  });

  it('removes the fragment before redemption while preserving query parameters', () => {
    const href = 'http://localhost:3000/kite/auth-complete?from=dashboard#code=secret-code';
    expect(stripCodeFragmentFromUrl(href)).toBe('/kite/auth-complete?from=dashboard');
  });

  it('keeps completion codes out of request URLs after fragment removal', () => {
    const href = 'http://localhost:3000/kite/auth-complete#code=secret-code';
    const stripped = stripCodeFragmentFromUrl(href);
    expect(stripped).not.toContain('secret-code');
    expect(stripped).not.toContain('#');
    expect(stripped).not.toContain('?code=');
  });

  it('supports Strict Mode remount after the fragment is removed', () => {
    const fragmentCode = parseCompletionCodeFromHash('#code=strict-mode-code');
    const firstResolve = resolveCompletionCode(fragmentCode);
    const stripped = stripCodeFragmentFromUrl(
      'http://localhost:3000/kite/auth-complete#code=strict-mode-code',
    );

    expect(firstResolve).toBe('strict-mode-code');
    expect(hasCapturedCompletionCode()).toBe(true);
    expect(stripped).toBe('/kite/auth-complete');
    expect(parseCompletionCodeFromHash('')).toBeNull();
    expect(resolveCompletionCode(null)).toBe('strict-mode-code');
  });

  it('does not trigger duplicate redemption for the same completion code', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(
          () => resolve(
            new Response(
              JSON.stringify({
                ok: true,
                kiteUserId: 'AB1234',
                authenticatedAt: '2026-01-01T00:00:00.000Z',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          ),
          10,
        );
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = redeemCompletionCode('dedupe-code');
    const second = redeemCompletionCode('dedupe-code');

    expect(getInFlightRedemptionCount()).toBe(1);
    expect(first).toBe(second);

    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/kite/auth/complete');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ code: 'dedupe-code' });
    expect(hasCapturedCompletionCode()).toBe(false);
    expect(getInFlightRedemptionCount()).toBe(0);
  });

  it('removes the captured code after successful settlement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          kiteUserId: 'AB1234',
          authenticatedAt: '2026-01-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    resolveCompletionCode('settle-success-code');
    expect(hasCapturedCompletionCode()).toBe(true);

    await redeemCompletionCode('settle-success-code');

    expect(hasCapturedCompletionCode()).toBe(false);
    expect(isRedemptionInFlight('settle-success-code')).toBe(false);
  });

  it('removes the captured code after failed settlement', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: 'Invalid or expired completion code' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    resolveCompletionCode('settle-failure-code');
    expect(hasCapturedCompletionCode()).toBe(true);

    const result = await redeemCompletionCode('settle-failure-code');

    expect(result).toEqual({ ok: false, message: 'Invalid or expired completion code' });
    expect(hasCapturedCompletionCode()).toBe(false);
    expect(isRedemptionInFlight('settle-failure-code')).toBe(false);
  });

  it('lets concurrent remounted callers share one in-flight promise during settlement', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    resolveCompletionCode('active-request-code');
    const first = redeemCompletionCode('active-request-code');

    expect(hasCapturedCompletionCode()).toBe(true);
    expect(getInFlightRedemptionCount()).toBe(1);

    const remounted = resolveCompletionCode(null);
    const second = redeemCompletionCode('active-request-code');

    expect(remounted).toBe('active-request-code');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.(
      new Response(
        JSON.stringify({
          ok: true,
          kiteUserId: 'AB1234',
          authenticatedAt: '2026-01-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await first;
    expect(hasCapturedCompletionCode()).toBe(false);
    expect(getInFlightRedemptionCount()).toBe(0);
  });

  it('does not reuse a stale captured code after a settled failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error: 'Invalid or expired completion code' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            kiteUserId: 'AB1234',
            authenticatedAt: '2026-01-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    resolveCompletionCode('retry-code');
    await redeemCompletionCode('retry-code');

    expect(hasCapturedCompletionCode()).toBe(false);
    expect(resolveCompletionCode(null)).toBeNull();

    const retry = redeemCompletionCode('retry-code');
    await retry;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
