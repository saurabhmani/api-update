// ════════════════════════════════════════════════════════════════
//  IndianAPI rate limiter — the PRIMARY protection against 429s.
//
//  Controls (retries are a secondary safety net, never the limiter):
//    • Global RPS ceiling — Redis-backed fixed-window counter shared
//      across processes, with an in-process fallback when Redis is
//      unavailable.
//    • Endpoint-group RPS — separate windows for stock / historical /
//      discovery so a historical backfill can't starve quote waves.
//    • Bounded concurrency — semaphore capping in-flight requests.
//    • Global pause — honoring Retry-After freezes the entire queue,
//      not just the failing request.
// ════════════════════════════════════════════════════════════════

import { getRedisClient } from '@/lib/redis';
import { getIndianApiIngestConfig } from '@/lib/marketData/providerFlags';

export type IndianApiEndpointGroup = 'stock' | 'historical' | 'discovery' | 'meta';

/** Per-group share of the global RPS budget (denominator; 1 = full). */
const GROUP_RPS_SHARE: Record<IndianApiEndpointGroup, number> = {
  stock: 1,       // quote waves get the full global budget
  historical: 2,  // half
  discovery: 2,   // half
  meta: 4,        // /usage etc — quarter
};

const RL_KEY_PREFIX = 'indianapi:rl';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.limit()) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  get active(): number {
    return this.inFlight;
  }

  get queued(): number {
    return this.waiters.length;
  }
}

export class IndianApiRateLimiter {
  private pausedUntil = 0;
  private readonly semaphore = new Semaphore(
    () => getIndianApiIngestConfig().maxConcurrency,
  );
  /** In-process fixed-window counters (fallback when Redis is down). */
  private readonly localWindows = new Map<string, { second: number; count: number }>();

  /** Freeze the entire queue (e.g. 429 Retry-After). */
  pauseFor(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.pausedUntil) this.pausedUntil = until;
  }

  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  private groupLimit(group: IndianApiEndpointGroup): number {
    const { rpsGlobal } = getIndianApiIngestConfig();
    return Math.max(1, Math.floor(rpsGlobal / GROUP_RPS_SHARE[group]));
  }

  /**
   * Consume one token for `group` in the current 1s window.
   * Returns true when allowed; false when the window is exhausted.
   */
  private async tryConsume(group: IndianApiEndpointGroup): Promise<boolean> {
    const second = Math.floor(Date.now() / 1000);
    const globalLimit = Math.max(1, getIndianApiIngestConfig().rpsGlobal);
    const groupLimit = this.groupLimit(group);

    const redis = getRedisClient();
    if (redis) {
      try {
        const globalKey = `${RL_KEY_PREFIX}:global:${second}`;
        const groupKey = `${RL_KEY_PREFIX}:${group}:${second}`;
        const result = await redis
          .multi()
          .incr(globalKey)
          .expire(globalKey, 2)
          .incr(groupKey)
          .expire(groupKey, 2)
          .exec();
        const globalCount = Number(result?.[0]?.[1] ?? 0);
        const groupCount = Number(result?.[2]?.[1] ?? 0);
        if (globalCount > globalLimit || groupCount > groupLimit) {
          return false;
        }
        return true;
      } catch {
        // fall through to local
      }
    }

    // In-process fallback (single-instance correctness only)
    const consumeLocal = (key: string, limit: number): boolean => {
      const entry = this.localWindows.get(key);
      if (!entry || entry.second !== second) {
        this.localWindows.set(key, { second, count: 1 });
        return 1 <= limit;
      }
      entry.count += 1;
      return entry.count <= limit;
    };
    const globalOk = consumeLocal('global', globalLimit);
    const groupOk = consumeLocal(group, groupLimit);
    return globalOk && groupOk;
  }

  /**
   * Wait for a slot: concurrency + rate token + global pause.
   * Callers MUST call release() in a finally block.
   */
  async acquire(group: IndianApiEndpointGroup): Promise<void> {
    await this.semaphore.acquire();
    try {
      // Bounded loop: worst case waits pausedForMs + a few windows.
      for (;;) {
        const pause = this.pausedForMs;
        if (pause > 0) {
          await sleep(pause);
          continue;
        }
        if (await this.tryConsume(group)) return;
        // Window exhausted — wait for the next second boundary (+ jitter
        // so parallel workers don't thundering-herd the same window).
        const nowMs = Date.now();
        const nextWindow = (Math.floor(nowMs / 1000) + 1) * 1000;
        await sleep(nextWindow - nowMs + Math.floor(Math.random() * 100));
      }
    } catch (err) {
      this.semaphore.release();
      throw err;
    }
  }

  release(): void {
    this.semaphore.release();
  }

  stats(): { active: number; queued: number; pausedForMs: number } {
    return {
      active: this.semaphore.active,
      queued: this.semaphore.queued,
      pausedForMs: this.pausedForMs,
    };
  }
}

/** Process-wide limiter shared by the adapter and orchestrator. */
let _limiter: IndianApiRateLimiter | null = null;

export function getIndianApiRateLimiter(): IndianApiRateLimiter {
  if (!_limiter) _limiter = new IndianApiRateLimiter();
  return _limiter;
}

/** Test hook. */
export function resetIndianApiRateLimiterForTests(): void {
  _limiter = null;
}
