import { describe, expect, it } from 'vitest';
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  buildPermissionsPolicy,
} from '@/lib/security/csp';

describe('security headers', () => {
  it('builds a production CSP without unsafe-eval or broad origins', () => {
    const csp = buildContentSecurityPolicy({
      nonce: 'test-nonce-value',
      pathname: '/dashboard',
      isDev: false,
      isProduction: true,
    });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce-value' 'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/\bhttps:\b/);
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('api.kite.trade');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
  });

  it('allows development websocket and eval requirements only in dev', () => {
    const csp = buildContentSecurityPolicy({
      nonce: 'dev-nonce',
      pathname: '/dashboard',
      isDev: true,
      isProduction: false,
    });

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('ws://localhost:3001');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('scopes Swagger docs to unpkg without opening the default app policy', () => {
    const csp = buildContentSecurityPolicy({
      nonce: 'ignored',
      pathname: '/api-docs',
      isDev: false,
      isProduction: true,
    });

    expect(csp).toContain('https://unpkg.com');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('api.kite.trade');
  });

  it('applies standard security headers and HSTS in production', () => {
    const headers = new Headers();

    applySecurityHeaders(headers, {
      nonce: 'nonce',
      pathname: '/kite/auth-complete',
      isDev: false,
      isProduction: true,
    });

    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Permissions-Policy')).toBe(buildPermissionsPolicy());
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('does not set HSTS outside production', () => {
    const headers = new Headers();

    applySecurityHeaders(headers, {
      nonce: 'nonce',
      pathname: '/dashboard',
      isDev: true,
      isProduction: false,
    });

    expect(headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('marks Kite API responses as non-cacheable at the proxy layer', () => {
    const headers = new Headers();

    applySecurityHeaders(headers, {
      nonce: 'nonce',
      pathname: '/api/kite/profile',
      isDev: false,
      isProduction: true,
    });

    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps the default referrer policy on non-auth-complete routes', () => {
    const headers = new Headers();

    applySecurityHeaders(headers, {
      nonce: 'nonce',
      pathname: '/dashboard',
      isDev: false,
      isProduction: true,
    });

    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
