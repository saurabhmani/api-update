// ════════════════════════════════════════════════════════════════
//  In-Memory Rate Limiter — Token Bucket per IP
//
//  Usage in API routes:
//    const limiter = createRateLimiter({ windowMs: 60000, max: 10 });
//    const check = limiter(req);
//    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 429 });
//
//  For auth endpoints: 5 req/min per IP
//  For general APIs:  60 req/min per IP
// ════════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server';

interface RateLimitConfig {
  windowMs: number;  // time window in ms
  max: number;       // max requests per window
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 300_000);

export function createRateLimiter(config: RateLimitConfig) {
  return function checkRate(req: NextRequest): { ok: boolean; error?: string; remaining: number } {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || req.headers.get('x-real-ip')
      || 'unknown';

    const key = `${ip}:${config.windowMs}:${config.max}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + config.windowMs });
      return { ok: true, remaining: config.max - 1 };
    }

    bucket.count++;

    if (bucket.count > config.max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      return {
        ok: false,
        error: `Rate limit exceeded. Try again in ${retryAfterSec}s`,
        remaining: 0,
      };
    }

    return { ok: true, remaining: config.max - bucket.count };
  };
}

// Pre-configured limiters
export const authLimiter = createRateLimiter({ windowMs: 60_000, max: 5 });    // 5/min for login/register
export const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });    // 60/min for general APIs
export const pipelineLimiter = createRateLimiter({ windowMs: 60_000, max: 3 }); // 3/min for pipeline triggers
