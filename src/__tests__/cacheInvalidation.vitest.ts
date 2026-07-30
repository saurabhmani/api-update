import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteByPattern } = vi.hoisted(() => ({
  deleteByPattern: vi.fn(async (_pattern: string) => 1),
}));

vi.mock('@/lib/cache/cacheService', () => ({
  cacheService: { deleteByPattern },
}));

import {
  CACHE_INVALIDATION_DEPENDENCIES,
  invalidatePortfolioCaches,
  invalidateSignalGeneratedCaches,
} from '@/lib/cache/cacheInvalidation';

describe('cache invalidation', () => {
  beforeEach(() => deleteByPattern.mockClear());

  it('documents every supported mutation domain', () => {
    expect(Object.keys(CACHE_INVALIDATION_DEPENDENCIES)).toEqual(
      expect.arrayContaining([
        'signal-generated',
        'signal-promoted',
        'portfolio-mutated',
        'paper-order-mutated',
        'strategy-mutated',
        'market-reference-mutated',
        'news-ingested',
        'user-settings-mutated',
      ]),
    );
  });

  it('invalidates all signal-dependent read domains', async () => {
    await invalidateSignalGeneratedCaches();
    const patterns = deleteByPattern.mock.calls.map(([pattern]) => pattern);
    expect(patterns.some((pattern) => pattern.includes(':signals:'))).toBe(true);
    expect(patterns.some((pattern) => pattern.includes(':rankings:'))).toBe(true);
    expect(patterns.some((pattern) => pattern.includes(':dashboard:'))).toBe(true);
    expect(patterns.some((pattern) => pattern.includes(':trade-setup:'))).toBe(true);
  });

  it('uses opaque user-scoped patterns and matches exact summaries', async () => {
    await invalidatePortfolioCaches('person@example.com');
    const patterns = deleteByPattern.mock.calls.map(([pattern]) => pattern);
    expect(patterns.join('\n')).not.toContain('person@example.com');
    expect(patterns.some((pattern) => pattern.includes(':portfolio:*:user-'))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith('*'))).toBe(true);
  });

  it('never uses database-wide Redis flush commands', () => {
    const source = [
      readFileSync('src/lib/cache/cacheInvalidation.ts', 'utf8'),
      readFileSync('src/lib/redis.ts', 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(/\bflush(?:all|db)\b/i);
  });
});
