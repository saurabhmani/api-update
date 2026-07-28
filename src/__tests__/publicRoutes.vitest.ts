import { describe, expect, it } from 'vitest';
import { isPublicPath, normalizePublicPath } from '@/lib/auth/publicRoutes';

describe('publicRoutes', () => {
  it('normalizes trailing slashes', () => {
    expect(normalizePublicPath('/careers/')).toBe('/careers');
    expect(normalizePublicPath('/')).toBe('/');
  });

  it('allows all corporate marketing routes without a session', () => {
    const routes = [
      '/',
      '/services',
      '/services/cloud-services',
      '/industries',
      '/industries/financial-services',
      '/about',
      '/resources',
      '/resources/case-studies/sample',
      '/careers',
      '/careers/',
      '/contact',
      '/privacy',
      '/case-studies/sample',
      '/api/auth',
      '/api/contact',
    ];
    for (const route of routes) {
      expect(isPublicPath(route), route).toBe(true);
    }
  });

  it('keeps private product surfaces protected', () => {
    const privateRoutes = [
      '/dashboard',
      '/admin/users',
      '/settings',
      '/signals',
      '/data-source',
      '/api/signals',
      '/api/watchlist',
    ];
    for (const route of privateRoutes) {
      expect(isPublicPath(route), route).toBe(false);
    }
  });
});
