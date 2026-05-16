// ════════════════════════════════════════════════════════════════
//  Resilience primitives — retry, timeout, circuit breaker, health
//
//  Reused across every adapter invocation inside MarketDataProvider.
//  Keeping these as pure functions (no class hierarchies) makes it
//  trivial to test and to reason about in a stack trace.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const log = logger.child({ component: 'providerResilience' });

// ── Timeout wrapper ────────────────────────────────────────────────
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Retry with exponential backoff ─────────────────────────────────
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label: string } = { label: 'op' },
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 100;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseMs * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Circuit breaker ────────────────────────────────────────────────
//
// Per-provider state. After `failureThreshold` consecutive failures,
// the breaker opens: further calls fail fast (no network hit) until
// `cooldownMs` elapses, at which point we allow a single trial call
// (half-open). A success closes the breaker; a failure reopens it.

type BreakerState = 'closed' | 'open' | 'half-open';

interface BreakerRecord {
  state: BreakerState;
  failures: number;
  openedAt: number;
  // Rolling health metrics
  totalCalls: number;
  totalFailures: number;
  lastLatencyMs: number;
}

export interface ProviderHealth {
  provider: string;
  state: BreakerState;
  successRate: number;
  totalCalls: number;
  lastLatencyMs: number;
}

class CircuitBreaker {
  private readonly records = new Map<string, BreakerRecord>();
  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  private rec(key: string): BreakerRecord {
    let r = this.records.get(key);
    if (!r) {
      r = { state: 'closed', failures: 0, openedAt: 0, totalCalls: 0, totalFailures: 0, lastLatencyMs: 0 };
      this.records.set(key, r);
    }
    return r;
  }

  async exec<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const r = this.rec(key);
    if (r.state === 'open') {
      if (Date.now() - r.openedAt < this.cooldownMs) {
        throw new Error(`circuit open for ${key}`);
      }
      r.state = 'half-open';
      log.info('circuit half-open', { provider: key });
    }
    const started = Date.now();
    r.totalCalls += 1;
    try {
      const out = await fn();
      r.lastLatencyMs = Date.now() - started;
      r.failures = 0;
      if (r.state !== 'closed') {
        r.state = 'closed';
        log.info('circuit closed', { provider: key });
      }
      return out;
    } catch (err) {
      r.lastLatencyMs = Date.now() - started;
      r.failures += 1;
      r.totalFailures += 1;
      if (r.failures >= this.failureThreshold) {
        r.state = 'open';
        r.openedAt = Date.now();
        log.warn('circuit opened', { provider: key, failures: r.failures });
      }
      throw err;
    }
  }

  health(): ProviderHealth[] {
    return [...this.records.entries()].map(([provider, r]) => ({
      provider,
      state: r.state,
      successRate: r.totalCalls === 0 ? 1 : 1 - r.totalFailures / r.totalCalls,
      totalCalls: r.totalCalls,
      lastLatencyMs: r.lastLatencyMs,
    }));
  }
}

export const breaker = new CircuitBreaker();

// ── Composite helper: retry + timeout + breaker ────────────────────
//
// Spec FIX-DATA-PIPELINE §1: provider request must time out at 5s and
// retry MAX twice (= 1 retry). The previous defaults (2s timeout,
// 3 attempts) interacted badly: a slow-but-eventually-succeeding
// upstream consumed 6s wall-clock per call before the fallback chain
// even saw the failure. The new defaults (5s timeout, 2 attempts =
// 1 retry) hard-cap a single guarded call at ~10s wall-clock and
// match the IndianAPI adapter's own retry semantics.
export async function guarded<T>(
  provider: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return breaker.exec(provider, () =>
    withRetry(() => withTimeout(fn(), timeoutMs, provider), {
      attempts: opts.attempts ?? 2,
      label: provider,
    }),
  );
}
