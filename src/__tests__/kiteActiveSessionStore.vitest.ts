import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const ACTIVE_SESSION_KEY = 'kite:active-session';
const ACTIVE_SESSION_TTL_SECONDS = 20 * 60 * 60;

type HashEntry = { fields: Map<string, string>; expiresAt: number | null };

const { fakeRedis, redisClientRef } = vi.hoisted(() => {
  class FakeActiveSessionRedis {
    private hashes = new Map<string, HashEntry>();
    private now = Date.now();

    clear(): void {
      this.hashes.clear();
      this.now = Date.now();
    }

    async hset(key: string, fields: Record<string, string>): Promise<number> {
      let entry = this.hashes.get(key);
      if (!entry) {
        entry = { fields: new Map(), expiresAt: null };
        this.hashes.set(key, entry);
      }
      let added = 0;
      for (const [field, value] of Object.entries(fields)) {
        if (!entry.fields.has(field)) added += 1;
        entry.fields.set(field, value);
      }
      return added;
    }

    async hget(key: string, field: string): Promise<string | null> {
      const entry = this.hashes.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && this.now >= entry.expiresAt) {
        this.hashes.delete(key);
        return null;
      }
      return entry.fields.get(field) ?? null;
    }

    async hgetall(key: string): Promise<Record<string, string>> {
      const entry = this.hashes.get(key);
      if (!entry) return {};
      if (entry.expiresAt !== null && this.now >= entry.expiresAt) {
        this.hashes.delete(key);
        return {};
      }
      return Object.fromEntries(entry.fields.entries());
    }

    async hkeys(key: string): Promise<string[]> {
      const all = await this.hgetall(key);
      return Object.keys(all);
    }

    async expire(key: string, seconds: number): Promise<number> {
      const entry = this.hashes.get(key);
      if (!entry) return 0;
      entry.expiresAt = this.now + seconds * 1000;
      return 1;
    }

    async del(key: string): Promise<number> {
      return this.hashes.delete(key) ? 1 : 0;
    }
  }

  const fakeRedis = new FakeActiveSessionRedis();
  return { fakeRedis, redisClientRef: { current: fakeRedis as unknown as object | null } };
});

vi.mock('@/lib/redis', () => ({
  getRedisClient: () => redisClientRef.current,
}));

import {
  clearActiveKiteSession,
  getActiveKiteAccessToken,
  getActiveKiteSession,
  saveActiveKiteSession,
} from '@/lib/kite/active-session-store';

describe('active Kite session store', () => {
  beforeEach(() => {
    fakeRedis.clear();
    redisClientRef.current = fakeRedis;
  });

  afterEach(() => {
    fakeRedis.clear();
  });

  it('saves and reads an active session', async () => {
    await saveActiveKiteSession({
      accessToken: 'tok-1',
      kiteUserId: 'KK9999',
      quantorusUserId: '42',
      authenticatedAt: '2026-07-22T12:00:00.000Z',
    });

    const session = await getActiveKiteSession();
    expect(session).toEqual({
      accessToken: 'tok-1',
      kiteUserId: 'KK9999',
      quantorusUserId: '42',
      authenticatedAt: '2026-07-22T12:00:00.000Z',
    });
    expect(await getActiveKiteAccessToken()).toBe('tok-1');
    expect(await fakeRedis.hkeys(ACTIVE_SESSION_KEY)).toEqual(
      expect.arrayContaining(['accessToken', 'kiteUserId', 'quantorusUserId', 'authenticatedAt']),
    );
  });

  it('clears only when access token matches', async () => {
    await saveActiveKiteSession({
      accessToken: 'tok-1',
      kiteUserId: 'KK9999',
      quantorusUserId: '42',
      authenticatedAt: '2026-07-22T12:00:00.000Z',
    });

    expect(await clearActiveKiteSession('other')).toBe(false);
    expect(await getActiveKiteAccessToken()).toBe('tok-1');

    expect(await clearActiveKiteSession('tok-1')).toBe(true);
    expect(await getActiveKiteAccessToken()).toBeNull();
  });

  it('fails closed when Redis is unavailable', async () => {
    redisClientRef.current = null;
    await expect(
      saveActiveKiteSession({
        accessToken: 'tok-1',
        kiteUserId: 'KK9999',
        quantorusUserId: '42',
        authenticatedAt: '2026-07-22T12:00:00.000Z',
      }),
    ).rejects.toThrow(/unavailable/i);
    expect(await getActiveKiteSession()).toBeNull();
  });

  it('uses the expected TTL window', () => {
    expect(ACTIVE_SESSION_TTL_SECONDS).toBe(20 * 60 * 60);
  });
});
