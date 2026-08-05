import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRedisExec = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn(() => null));

vi.mock('@/lib/redis', () => ({
  getRedisClient: mockGetRedisClient,
}));

const childInfo = vi.hoisted(() => vi.fn());
const childWarn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: childInfo,
      warn: childWarn,
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

import {
  getIndianApiRequestsPerSecond,
  resetIndianApiRpsWarningsForTests,
} from '@/lib/marketData/providerFlags';
import {
  getIndianApiRateLimiter,
  resetIndianApiRateLimiterForTests,
  type IndianApiEndpointGroup,
} from '@/lib/marketData/providers/indianApiRateLimiter';

describe('getIndianApiRequestsPerSecond', () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.INDIAN_API_REQUESTS_PER_SECOND;
    delete process.env.INDIANAPI_RPS_GLOBAL;
    resetIndianApiRpsWarningsForTests();
    childWarn.mockReset();
  });

  afterEach(() => {
    process.env = env;
    resetIndianApiRpsWarningsForTests();
  });

  it('defaults to 10 when unset', () => {
    expect(getIndianApiRequestsPerSecond()).toBe(10);
  });

  it('reads INDIAN_API_REQUESTS_PER_SECOND', () => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '25';
    expect(getIndianApiRequestsPerSecond()).toBe(25);
  });

  it('uses INDIANAPI_RPS_GLOBAL as legacy alias when primary unset', () => {
    process.env.INDIANAPI_RPS_GLOBAL = '7';
    expect(getIndianApiRequestsPerSecond()).toBe(7);
  });

  it('prefers INDIAN_API_REQUESTS_PER_SECOND over legacy alias', () => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '12';
    process.env.INDIANAPI_RPS_GLOBAL = '3';
    expect(getIndianApiRequestsPerSecond()).toBe(12);
  });

  it('falls back to 10 for empty primary and uses legacy without warning', () => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '';
    process.env.INDIANAPI_RPS_GLOBAL = '6';
    expect(getIndianApiRequestsPerSecond()).toBe(6);
    expect(childWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['non-numeric', 'abc'],
    ['NaN literal', 'NaN'],
  ])('falls back to 10 for invalid primary value: %s', (_label, value) => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = value;
    expect(getIndianApiRequestsPerSecond()).toBe(10);
    expect(childWarn).toHaveBeenCalled();
  });

  it('truncates decimal primary values with a warning', () => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '7.9';
    expect(getIndianApiRequestsPerSecond()).toBe(7);
    expect(childWarn).toHaveBeenCalledWith(
      'Non-integer IndianAPI requests-per-second — truncating',
      expect.objectContaining({ envName: 'INDIAN_API_REQUESTS_PER_SECOND', resolved: 7 }),
    );
  });

  it('ignores invalid legacy when primary is valid', () => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '8';
    process.env.INDIANAPI_RPS_GLOBAL = 'bad';
    expect(getIndianApiRequestsPerSecond()).toBe(8);
  });
});

describe('IndianApiRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    childInfo.mockReset();
    resetIndianApiRateLimiterForTests();
    mockGetRedisClient.mockReturnValue(null);
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '1';
  });

  afterEach(() => {
    vi.useRealTimers();
    resetIndianApiRateLimiterForTests();
  });

  it('logs when waiting for the next fixed-window second', async () => {
    const limiter = getIndianApiRateLimiter();
    const group: IndianApiEndpointGroup = 'stock';

    await limiter.acquire(group).then(() => limiter.release());

    const second = limiter.acquire(group);
    await vi.advanceTimersByTimeAsync(1100);
    await second.then(() => limiter.release());

    expect(childInfo).toHaveBeenCalledWith(
      'IndianAPI rate limit wait',
      expect.objectContaining({ event: 'indianapi_rate_limit_wait', reason: 'rps_window', group: 'stock' }),
    );
  });

  it('logs global pause waits after 429 Retry-After', async () => {
    const limiter = getIndianApiRateLimiter();
    limiter.pauseFor(500);
    const pending = limiter.acquire('meta');
    await vi.advanceTimersByTimeAsync(500);
    await pending.then(() => limiter.release());

    expect(childInfo).toHaveBeenCalledWith(
      'IndianAPI rate limit wait',
      expect.objectContaining({ event: 'indianapi_rate_limit_wait', reason: 'global_pause', group: 'meta' }),
    );
  });

  it('queues concurrent requests above the configured RPS limit', async () => {
    process.env.INDIAN_API_REQUESTS_PER_SECOND = '2';
    resetIndianApiRateLimiterForTests();
    const limiter = getIndianApiRateLimiter();

    await limiter.acquire('stock').then(() => limiter.release());
    await limiter.acquire('stock').then(() => limiter.release());

    const third = limiter.acquire('stock');
    let thirdDone = false;
    void third.then(() => {
      thirdDone = true;
      limiter.release();
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(thirdDone).toBe(false);

    await vi.advanceTimersByTimeAsync(1100);
    await third;
    expect(thirdDone).toBe(true);
  });

  it('releases semaphore slots even when acquire loop is interrupted', async () => {
    const limiter = getIndianApiRateLimiter();
    limiter.pauseFor(60_000);
    const pending = limiter.acquire('stock');
    await vi.advanceTimersByTimeAsync(10);
    pending.catch(() => {});
    limiter.release();
    expect(limiter.stats().active).toBe(0);
  });

  it('falls back to in-process limiting when Redis errors', async () => {
    mockGetRedisClient.mockReturnValue({
      multi: () => ({
        incr: () => ({ expire: () => ({ incr: () => ({ expire: () => ({ exec: mockRedisExec }) }) }) }),
        exec: mockRedisExec,
      }),
    } as never);
    mockRedisExec.mockRejectedValue(new Error('redis down'));

    const limiter = getIndianApiRateLimiter();
    await limiter.acquire('stock').then(() => limiter.release());
    expect(limiter.stats().active).toBe(0);
  });

  it('uses Redis shared counters when available', async () => {
    mockRedisExec.mockResolvedValue([
      [null, 1],
      [null, 1],
      [null, 1],
      [null, 1],
    ]);
    mockGetRedisClient.mockReturnValue({
      multi: () => {
        const chain = {
          incr: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: mockRedisExec,
        };
        return chain;
      },
    } as never);

    const limiter = getIndianApiRateLimiter();
    await limiter.acquire('stock').then(() => limiter.release());
    expect(mockRedisExec).toHaveBeenCalled();
  });
});
