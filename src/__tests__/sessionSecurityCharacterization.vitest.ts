import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  query: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookieGet }) }));
vi.mock('@/lib/db', () => ({ db: { query: mocks.query } }));
vi.mock('@/lib/redis', () => ({ cacheGet: mocks.cacheGet, cacheSet: mocks.cacheSet }));

import { getSession, requireAdmin, requirePermission, requireSession } from '@/lib/session';

describe('database session security characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieGet.mockReturnValue(undefined);
    mocks.cacheGet.mockResolvedValue(null);
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.cacheSet.mockResolvedValue(undefined);
  });

  it('does not treat cookie absence or presence alone as authentication', async () => {
    await expect(getSession()).resolves.toBeNull();
    mocks.cookieGet.mockReturnValue({ value: 'invalid-token' });
    await expect(requireSession()).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('s.expires_at > NOW()'), ['invalid-token']);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('u.is_active = TRUE'), ['invalid-token']);
  });

  it('rejects expired or revoked sessions represented by no active DB row', async () => {
    mocks.cookieGet.mockReturnValue({ value: 'expired-or-revoked' });
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(requireSession()).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects normal users at admin and permission gates', async () => {
    mocks.cookieGet.mockReturnValue({ value: 'valid-user' });
    mocks.query.mockResolvedValue({ rows: [{ id: 1, email: 'u@example.test', name: null, role: 'user' }] });
    await expect(requireAdmin()).rejects.toMatchObject({ statusCode: 403 });
    await expect(requirePermission('admin:security')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('bounds a database-validated session cache entry to the existing 300-second TTL', async () => {
    mocks.cookieGet.mockReturnValue({ value: 'valid-admin' });
    mocks.query.mockResolvedValue({ rows: [{ id: 2, email: 'a@example.test', name: null, role: 'admin' }] });
    await expect(getSession()).resolves.toMatchObject({ id: 2, role: 'admin' });
    expect(mocks.cacheSet).toHaveBeenCalledWith('session:valid-admin', expect.any(Object), 300);
  });
});
