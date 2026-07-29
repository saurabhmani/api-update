import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

describe('appRedirects public host preference', () => {
  const keys = ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const key of keys) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  it('keeps dig host when Next sees internal localhost behind a proxy', async () => {
    process.env.APP_BASE_URL = 'https://quantorus.in';
    const { resolveAppRedirectOrigin, appPathUrl } = await import(
      '@/lib/broker/oauth/appRedirects'
    );
    const req = new NextRequest('http://localhost:3000/api/brokers/shoonya/callback?code=x', {
      headers: {
        'x-forwarded-host': 'quantorus.in',
        'x-forwarded-proto': 'https',
      },
    });
    expect(resolveAppRedirectOrigin(req)).toBe('https://quantorus.in');
    expect(appPathUrl(req, '/dashboard').toString()).toBe(
      'https://quantorus.in/dashboard',
    );
  });

  it('does not let localhost APP_* override a public request host', async () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    const { resolveAppRedirectOrigin } = await import('@/lib/broker/oauth/appRedirects');
    const req = new NextRequest('https://quantorus.in/api/brokers/shoonya/callback?code=x');
    expect(resolveAppRedirectOrigin(req)).toBe('https://quantorus.in');
  });

  it('uses nginx Host when APP_* is localhost and X-Forwarded-Host is absent', async () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    process.env.APP_URL = 'http://localhost:3000';
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    const { resolveAppRedirectOrigin, appPathUrl } = await import(
      '@/lib/broker/oauth/appRedirects'
    );
    const req = new NextRequest('http://localhost:5000/api/brokers/shoonya/callback?code=x', {
      headers: {
        host: 'quantorus.in',
        'x-forwarded-proto': 'https',
      },
    });
    expect(resolveAppRedirectOrigin(req)).toBe('https://quantorus.in');
    expect(appPathUrl(req, '/dashboard').toString()).toBe(
      'https://quantorus.in/dashboard',
    );
  });

  it('uses http loopback for genuine local requests', async () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    const { resolveAppRedirectOrigin } = await import('@/lib/broker/oauth/appRedirects');
    const req = new NextRequest('http://localhost:3000/api/brokers/shoonya/callback?code=x');
    expect(resolveAppRedirectOrigin(req)).toBe('http://localhost:3000');
  });
});
