import { createHash } from 'node:crypto';
import { cacheDel, cacheDelByPattern, cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { CachePolicy, normalizeCachePolicy } from './cachePolicy';
import {
  observeRedis,
  recordCacheOutcome,
} from '@/lib/monitor/apiPerformanceMetrics';

interface CacheEnvelope<T> {
  schema: 'q365-cache-v1';
  value: T;
  freshUntil: number;
  staleUntil: number;
}

export interface CacheRead<T> {
  value: T | null;
  state: 'hit' | 'stale' | 'miss';
}

export interface GetOrSetOptions extends CachePolicy {
  allowStale?: boolean;
}

const inFlight = new Map<string, Promise<unknown>>();
const cacheLog = logger.child({ component: 'cacheService' });

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function logState(state: CacheRead<unknown>['state'], key: string): void {
  // Never log the raw key because a legacy caller may have embedded a token.
  cacheLog.debug(`cache ${state}`, { cache_key_fingerprint: keyFingerprint(key) });
}

function isEnvelope<T>(value: unknown): value is CacheEnvelope<T> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CacheEnvelope<T>>;
  return item.schema === 'q365-cache-v1'
    && typeof item.freshUntil === 'number'
    && typeof item.staleUntil === 'number'
    && Object.prototype.hasOwnProperty.call(item, 'value');
}

async function safeRead<T>(key: string): Promise<CacheEnvelope<T> | null> {
  try {
    const value = await observeRedis(() => cacheGet<unknown>(key));
    return isEnvelope<T>(value) ? value : null;
  } catch (error) {
    cacheLog.rateLimited('warn', 'cache read unavailable; using fallback', keyFingerprint(key), {
      cache_key_fingerprint: keyFingerprint(key),
      error_name: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

async function safeWrite<T>(
  key: string,
  value: T,
  policy: Required<CachePolicy>,
): Promise<void> {
  const now = Date.now();
  const envelope: CacheEnvelope<T> = {
    schema: 'q365-cache-v1',
    value,
    freshUntil: now + policy.ttlSeconds * 1000,
    staleUntil: now
      + (policy.ttlSeconds + policy.staleWhileRevalidateSeconds) * 1000,
  };
  try {
    await observeRedis(() => cacheSet(
      key,
      envelope,
      policy.ttlSeconds + policy.staleWhileRevalidateSeconds,
    ));
  } catch (error) {
    cacheLog.rateLimited('warn', 'cache write unavailable; continuing', keyFingerprint(key), {
      cache_key_fingerprint: keyFingerprint(key),
      error_name: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function loadCoalesced<T>(
  key: string,
  loader: () => Promise<T>,
  policy: Required<CachePolicy>,
): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const request = (async () => {
    const value = await loader();
    if (value !== null || policy.cacheNull) await safeWrite(key, value, policy);
    return value;
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

async function getWithMetadata<T>(key: string): Promise<CacheRead<T>> {
  const envelope = await safeRead<T>(key);
  const now = Date.now();
  if (!envelope || now > envelope.staleUntil) {
    logState('miss', key);
    recordCacheOutcome('miss');
    return { value: null, state: 'miss' };
  }
  if (now > envelope.freshUntil) {
    logState('stale', key);
    recordCacheOutcome('stale');
    return { value: envelope.value, state: 'stale' };
  }
  logState('hit', key);
  recordCacheOutcome('hit');
  return { value: envelope.value, state: 'hit' };
}

export const cacheService = {
  getWithMetadata,

  async get<T>(key: string): Promise<T | null> {
    const result = await getWithMetadata<T>(key);
    return result.state === 'hit' ? result.value : null;
  },

  async set<T>(
    key: string,
    value: T,
    policy: CachePolicy | number,
  ): Promise<void> {
    await safeWrite(key, value, normalizeCachePolicy(policy));
  },

  async delete(key: string): Promise<void> {
    try {
      await observeRedis(() => cacheDel(key));
    } catch {
      // Cache invalidation must not make the primary API unavailable.
    }
  },

  async deleteByPattern(pattern: string): Promise<number> {
    try {
      return await observeRedis(() => cacheDelByPattern(pattern));
    } catch {
      return 0;
    }
  },

  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options: GetOrSetOptions,
  ): Promise<T> {
    const policy = normalizeCachePolicy(options);
    const cached = await getWithMetadata<T>(key);
    if (cached.state === 'hit') return cached.value as T;

    if (
      cached.state === 'stale'
      && options.allowStale !== false
      && policy.staleWhileRevalidateSeconds > 0
    ) {
      void loadCoalesced(key, loader, policy).catch((error) => {
        cacheLog.rateLimited('warn', 'cache background refresh failed', keyFingerprint(key), {
          cache_key_fingerprint: keyFingerprint(key),
          error_name: error instanceof Error ? error.name : 'UnknownError',
        });
      });
      return cached.value as T;
    }

    return loadCoalesced(key, loader, policy);
  },
};

export type CacheService = typeof cacheService;
