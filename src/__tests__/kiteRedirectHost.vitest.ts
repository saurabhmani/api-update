import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

describe('kite redirect-host helpers', () => {
  const envKeys = [
    'KITE_REDIRECT_URL',
    'APP_BASE_URL',
    'APP_URL',
    'NEXT_PUBLIC_APP_URL',
  ] as const;
  const previous = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  function clearEnv() {
    for (const key of envKeys) delete process.env[key];
  }

  beforeEach(() => {
    clearEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearEnv();
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('detects localhost KITE_REDIRECT_URL while the browser is on a public host', async () => {
    process.env.KITE_REDIRECT_URL = 'http://localhost:3000/api/kite/auth/callback';
    const { isKiteRedirectHostMismatch } = await import('@/lib/kite/redirect-host');
    const req = new NextRequest('https://dev.quantorus.in/api/brokers/zerodha/connect');
    expect(isKiteRedirectHostMismatch(req)).toBe(true);
  });

  it('allows matching public redirect host', async () => {
    process.env.KITE_REDIRECT_URL = 'https://dev.quantorus.in/api/kite/auth/callback';
    const { isKiteRedirectHostMismatch } = await import('@/lib/kite/redirect-host');
    const req = new NextRequest('https://dev.quantorus.in/api/brokers/zerodha/connect');
    expect(isKiteRedirectHostMismatch(req)).toBe(false);
  });

  it('allows loopback-to-loopback local development', async () => {
    process.env.KITE_REDIRECT_URL = 'http://localhost:3000/api/kite/auth/callback';
    const { isKiteRedirectHostMismatch } = await import('@/lib/kite/redirect-host');
    const req = new NextRequest('http://localhost:3000/api/brokers/zerodha/connect');
    expect(isKiteRedirectHostMismatch(req)).toBe(false);
  });

  it('flags Zerodha callbacks that land on localhost when config is public', async () => {
    process.env.KITE_REDIRECT_URL = 'https://dev.quantorus.in/api/kite/auth/callback';
    const {
      isKiteCallbackOnWrongLoopbackHost,
      buildKiteRedirectMismatchUrl,
    } = await import('@/lib/kite/redirect-host');
    const req = new NextRequest(
      'http://localhost:3000/api/kite/auth/callback?status=success&request_token=x&state=y',
    );
    expect(isKiteCallbackOnWrongLoopbackHost(req)).toBe(true);
    expect(buildKiteRedirectMismatchUrl('https://dev.quantorus.in')).toContain(
      'error=redirect_url_mismatch',
    );
  });
});
