import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn(async (pw: string) => `hashed:${pw}`),
    compare: vi.fn(),
  },
}));

import { db } from '@/lib/db';
import { createUserByAdmin } from '@/services/auth';

const ROOT = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('createUserByAdmin', () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset();
  });

  it('rejects missing name', async () => {
    const result = await createUserByAdmin('test@example.com', 'Strong1pass', '   ');
    expect(result).toEqual({ error: 'Name is required' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects invalid email', async () => {
    const result = await createUserByAdmin('not-an-email', 'Strong1pass', 'Jane Doe');
    expect(result).toEqual({ error: 'Invalid email address' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects weak password', async () => {
    const result = await createUserByAdmin('test@example.com', 'short', 'Jane Doe');
    expect(result).toEqual({ error: 'Password must be at least 8 characters' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects duplicate email before insert', async () => {
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [{ id: 7 }] } as never);

    const result = await createUserByAdmin('dup@example.com', 'Strong1pass', 'Jane Doe');
    expect(result).toEqual({ error: 'An account with this email already exists' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('creates user and returns mapped row', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [], insertId: 42 } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          email: 'new@example.com',
          name: 'Jane Doe',
          role: 'admin',
          is_active: 1,
          totp_enabled: 0,
          last_login_at: null,
          created_at: '2026-07-02 10:00:00',
        }],
      } as never);

    const result = await createUserByAdmin('new@example.com', 'Strong1pass', 'Jane Doe', 'admin');
    expect('user' in result && result.user).toMatchObject({
      id: 42,
      email: 'new@example.com',
      name: 'Jane Doe',
      role: 'admin',
      is_active: true,
      totp_enabled: false,
      last_login_at: null,
    });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('maps duplicate key errors to a friendly message', async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockRejectedValueOnce({ code: 'ER_DUP_ENTRY', errno: 1062 } as never);

    const result = await createUserByAdmin('race@example.com', 'Strong1pass', 'Jane Doe');
    expect(result).toEqual({ error: 'An account with this email already exists' });
  });
});

describe('admin users UI contracts', () => {
  const page = read('src/app/admin/users/page.tsx');
  const apiClient = read('src/lib/apiClient.ts');
  const adminRoute = read('src/app/api/admin/route.ts');

  it('exposes Add User action and create-user API wiring', () => {
    expect(page).toMatch(/Add User/);
    expect(page).toMatch(/adminApi\.createUser/);
    expect(apiClient).toMatch(/createUser:\s*\(data: unknown\)\s*=>\s*post\('\/admin\?resource=user'/);
  });

  it('validates required fields before submit', () => {
    expect(page).toMatch(/validateCreateForm/);
    expect(page).toMatch(/Passwords do not match/);
    expect(page).toMatch(/Invalid email address/);
  });

  it('refreshes list locally after successful creation', () => {
    expect(page).toMatch(/setUsers\(prev => \[res\.user, \.\.\.prev\]\)/);
  });

  it('admin POST route handles resource=user creation', () => {
    expect(adminRoute).toMatch(/resource === 'user'/);
    expect(adminRoute).toMatch(/createUserByAdmin/);
    expect(adminRoute).toMatch(/already exists.*409/);
  });
});
