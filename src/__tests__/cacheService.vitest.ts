import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
    }),
    cacheDel: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    cacheDelByPattern: vi.fn(async (pattern: string) => {
      const matcher = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
      );
      let deleted = 0;
      for (const key of store.keys()) {
        if (!matcher.test(key)) continue;
        store.delete(key);
        deleted += 1;
      }
      return deleted;
    }),
  };
});

vi.mock('@/lib/redis', () => redisMock);

import { cacheKey, cacheKeys, getCacheKeyPrefix } from '@/lib/cache/cacheKeys';
import { cacheService } from '@/lib/cache/cacheService';

describe('central cache service', () => {
  beforeEach(() => {
    redisMock.store.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('builds environment-prefixed, versioned and scoped keys', () => {
    expect(cacheKeys.marketQuote('reliance')).toBe(
      `${getCacheKeyPrefix()}:market:quote:RELIANCE`,
    );
    expect(cacheKeys.signalsList('123', '30d')).toMatch(
      new RegExp(`^${getCacheKeyPrefix()}:signals:list:user-[a-f0-9]{16}:30d$`),
    );
    expect(cacheKeys.portfolioSummary('123')).not.toContain(':123');
  });

  it('rejects secrets and token-like values in keys', () => {
    expect(() => cacheKey('auth', 'access-token', 'value')).toThrow(/Sensitive/);
    expect(() => cacheKey('market', 'quote', 'a'.repeat(64))).toThrow(/Token-like/);
  });

  it('round-trips JSON through the centralized envelope', async () => {
    const key = cacheKey('test', 'json', 'one');
    await cacheService.set(key, { nested: ['safe', 42] }, 60);

    await expect(cacheService.get(key)).resolves.toEqual({
      nested: ['safe', 42],
    });
    expect(redisMock.cacheSet).toHaveBeenCalledWith(
      key,
      expect.objectContaining({ schema: 'q365-cache-v1' }),
      60,
    );
  });

  it('returns a cache hit without calling the loader', async () => {
    const key = cacheKey('test', 'hit', 'one');
    await cacheService.set(key, { source: 'cache' }, 60);
    const loader = vi.fn(async () => ({ source: 'database' }));

    await expect(cacheService.getOrSet(
      key,
      loader,
      { ttlSeconds: 60 },
    )).resolves.toEqual({ source: 'cache' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('loads and caches a cache miss', async () => {
    const key = cacheKey('test', 'miss', 'one');
    const loader = vi.fn(async () => ({ source: 'database' }));

    await expect(cacheService.getOrSet(
      key,
      loader,
      { ttlSeconds: 60 },
    )).resolves.toEqual({ source: 'database' });
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(cacheService.get(key)).resolves.toEqual({ source: 'database' });
  });

  it('treats an expired envelope as a miss', async () => {
    vi.useFakeTimers();
    const key = cacheKey('test', 'expiry', 'one');
    await cacheService.set(key, { generation: 1 }, 1);
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(cacheService.get(key)).resolves.toBeNull();
  });

  it('treats malformed or unparseable cache payloads as a miss', async () => {
    const key = cacheKey('test', 'malformed', 'one');
    redisMock.store.set(key, '{not-json');
    await expect(cacheService.get(key)).resolves.toBeNull();
    redisMock.store.set(key, { schema: 'unexpected-shape' });
    await expect(cacheService.get(key)).resolves.toBeNull();
  });

  it('coalesces concurrent misses into one loader call', async () => {
    const key = cacheKey('test', 'coalesce', 'one');
    let resolveLoader!: (value: { ok: boolean }) => void;
    const loader = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      resolveLoader = resolve;
    }));

    const first = cacheService.getOrSet(key, loader, { ttlSeconds: 60 });
    const second = cacheService.getOrSet(key, loader, { ttlSeconds: 60 });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    resolveLoader({ ok: true });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it('serves stale data while one background refresh runs', async () => {
    vi.useFakeTimers();
    const key = cacheKey('test', 'swr', 'one');
    await cacheService.set(
      key,
      { generation: 1 },
      { ttlSeconds: 1, staleWhileRevalidateSeconds: 30 },
    );
    await vi.advanceTimersByTimeAsync(1_100);

    const loader = vi.fn(async () => ({ generation: 2 }));
    await expect(cacheService.getOrSet(key, loader, {
      ttlSeconds: 1,
      staleWhileRevalidateSeconds: 30,
    })).resolves.toEqual({ generation: 1 });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      await expect(cacheService.get(key)).resolves.toEqual({ generation: 2 });
    });
  });

  it('falls back to the loader when Redis reads fail', async () => {
    redisMock.cacheGet.mockRejectedValueOnce(new Error('redis unavailable'));
    const loader = vi.fn(async () => ({ source: 'mysql' }));

    await expect(cacheService.getOrSet(
      cacheKey('test', 'fallback', 'one'),
      loader,
      { ttlSeconds: 60 },
    )).resolves.toEqual({ source: 'mysql' });
  });

  it('returns loaded data when the Redis write fails', async () => {
    redisMock.cacheSet.mockRejectedValueOnce(new Error('redis unavailable'));
    const loader = vi.fn(async () => ({ source: 'provider' }));
    await expect(cacheService.getOrSet(
      cacheKey('test', 'write-fallback', 'one'),
      loader,
      { ttlSeconds: 60 },
    )).resolves.toEqual({ source: 'provider' });
  });

  it('isolates cached values between users', async () => {
    const userAKey = cacheKeys.portfolioSummary('user-a');
    const userBKey = cacheKeys.portfolioSummary('user-b');
    expect(userAKey).not.toBe(userBKey);
    await cacheService.set(userAKey, { owner: 'A' }, 60);
    await cacheService.set(userBKey, { owner: 'B' }, 60);
    await expect(cacheService.get(userAKey)).resolves.toEqual({ owner: 'A' });
    await expect(cacheService.get(userBKey)).resolves.toEqual({ owner: 'B' });
  });

  it('does not place raw user identifiers or secrets in keys or cache logs', () => {
    const key = cacheKeys.signalsList('person@example.com', '30d');
    expect(key).not.toContain('person@example.com');
    const source = readFileSync('src/lib/cache/cacheService.ts', 'utf8');
    expect(source).not.toContain('cache_key: key');
    expect(source).not.toContain('raw_key');
    expect(source).toContain('cache_key_fingerprint');
    expect(source).toContain('keyFingerprint(key)');
  });

  it('supports pattern invalidation', async () => {
    const one = cacheKey('market', 'quote', 'ONE');
    const two = cacheKey('market', 'quote', 'TWO');
    const other = cacheKey('market', 'status', 'NSE');
    await cacheService.set(one, 1, 60);
    await cacheService.set(two, 2, 60);
    await cacheService.set(other, 3, 60);

    await expect(cacheService.deleteByPattern(
      `${getCacheKeyPrefix()}:market:quote:*`,
    )).resolves.toBe(2);
    await expect(cacheService.get(other)).resolves.toBe(3);
  });
});
