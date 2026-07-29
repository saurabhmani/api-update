import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveInternalOrigin } from '@/lib/api/internalFetch';

describe('resolveInternalOrigin', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses loopback in production when no APP_URL is set', () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      PORT: '5000',
    };
    delete process.env.APP_URL;
    delete process.env.INTERNAL_APP_URL;

    const fakeReq = { nextUrl: { origin: 'https://quantorus.in' } } as never;
    expect(resolveInternalOrigin(fakeReq)).toBe('http://127.0.0.1:5000');
  });

  it('prefers INTERNAL_APP_URL in production', () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      INTERNAL_APP_URL: 'http://127.0.0.1:5000/',
    };

    const fakeReq = { nextUrl: { origin: 'https://quantorus.in' } } as never;
    expect(resolveInternalOrigin(fakeReq)).toBe('http://127.0.0.1:5000');
  });

  it('ignores public APP_URL in production and uses loopback', () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'production',
      PORT: '5000',
      APP_URL: 'https://quantorus.in',
    };
    delete process.env.INTERNAL_APP_URL;

    const fakeReq = { nextUrl: { origin: 'https://quantorus.in' } } as never;
    expect(resolveInternalOrigin(fakeReq)).toBe('http://127.0.0.1:5000');
  });

  it('uses loopback in development and ignores request origin', () => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'development',
    };
    delete process.env.INTERNAL_APP_URL;
    delete process.env.APP_URL;
    delete process.env.PORT;

    const fakeReq = { nextUrl: { origin: 'http://localhost:3000' } } as never;
    expect(resolveInternalOrigin(fakeReq)).toBe('http://127.0.0.1:3000');
  });
});
