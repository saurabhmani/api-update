// API Rate Limiting — Redis-backed with in-memory fallback

import { NextRequest } from 'next/server';
import { cacheGet, cacheSet } from '@/lib/redis';
import { RateLimitError } from '@/lib/errors';

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
}

const memoryBuckets = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
}

export async function checkRateLimit(
  req: NextRequest,
  config: RateLimitConfig,
): Promise<{ ok: boolean; remaining: number; retryAfterSec?: number }> {
  const ip = clientIp(req);
  const key = `${config.keyPrefix}:${ip}`;
  const now = Date.now();

  try {
    const cached = await cacheGet<{ count: number; resetAt: number }>(`rl:${key}`);
    if (!cached || cached.resetAt < now) {
      const resetAt = now + config.windowMs;
      await cacheSet(`rl:${key}`, { count: 1, resetAt }, Math.ceil(config.windowMs / 1000));
      return { ok: true, remaining: config.max - 1 };
    }
    const count = cached.count + 1;
    if (count > config.max) {
      return {
        ok: false,
        remaining: 0,
        retryAfterSec: Math.ceil((cached.resetAt - now) / 1000),
      };
    }
    await cacheSet(`rl:${key}`, { count, resetAt: cached.resetAt }, Math.ceil((cached.resetAt - now) / 1000));
    return { ok: true, remaining: config.max - count };
  } catch {
    // Fallback to in-memory
    const memKey = `${key}:${config.windowMs}`;
    const bucket = memoryBuckets.get(memKey);
    if (!bucket || bucket.resetAt < now) {
      memoryBuckets.set(memKey, { count: 1, resetAt: now + config.windowMs });
      return { ok: true, remaining: config.max - 1 };
    }
    bucket.count++;
    if (bucket.count > config.max) {
      return { ok: false, remaining: 0, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
    }
    return { ok: true, remaining: config.max - bucket.count };
  }
}

export async function enforceRateLimit(req: NextRequest, config: RateLimitConfig): Promise<void> {
  const result = await checkRateLimit(req, config);
  if (!result.ok) {
    throw new RateLimitError(
      `Rate limit exceeded. Try again in ${result.retryAfterSec ?? 60}s`,
    );
  }
}

export const RATE_LIMITS = {
  auth: { windowMs: 60_000, max: 5, keyPrefix: 'auth' },
  api: { windowMs: 60_000, max: 60, keyPrefix: 'api' },
  pipeline: { windowMs: 60_000, max: 3, keyPrefix: 'pipeline' },
  security: { windowMs: 60_000, max: 30, keyPrefix: 'security' },
} as const;
