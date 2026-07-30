import { describe, expect, it } from 'vitest';
import {
  commitApiPerformanceContext,
  getApiPerformanceContext,
  observeDb,
  observeProvider,
  observeRedis,
  recordCacheOutcome,
  recordTradeSetupDeduplicated,
  recordTradeSetupGeneration,
  renderApiPerformanceMetrics,
  runWithApiPerformanceContext,
} from '@/lib/monitor/apiPerformanceMetrics';

describe('API performance observability', () => {
  it('attributes timings and cache outcomes to the active request', async () => {
    await runWithApiPerformanceContext({
      route: '/api/test',
      method: 'GET',
      requestId: 'request-test',
    }, async () => {
      await observeDb(async () => 'db');
      await observeRedis(async () => 'redis');
      await observeProvider(async () => 'provider');
      recordCacheOutcome('hit');
      recordCacheOutcome('miss');
      const context = getApiPerformanceContext();
      expect(context?.dbQueryCount).toBe(1);
      expect(context?.cacheHitCount).toBe(1);
      expect(context?.cacheMissCount).toBe(1);
      commitApiPerformanceContext(12);
    });

    const output = renderApiPerformanceMetrics();
    expect(output).toContain('q365_api_request_duration_ms{route="/api/test",method="GET"} 12');
    expect(output).toContain('q365_api_cache_hit_total{route="/api/test",method="GET"} 1');
    expect(output).toContain('q365_api_cache_miss_total{route="/api/test",method="GET"} 1');
    expect(output).toContain('q365_api_db_duration_ms');
    expect(output).toContain('q365_api_provider_duration_ms');
  });

  it('exports trade setup generation and deduplication metrics', async () => {
    recordTradeSetupGeneration(25);
    recordTradeSetupDeduplicated();
    const output = renderApiPerformanceMetrics();
    expect(output).toContain('q365_trade_setup_generation_duration_ms 25');
    expect(output).toContain('q365_trade_setup_generation_deduplicated_total 1');
  });

  it('does not expose request IDs or user IDs as metric labels', () => {
    const output = renderApiPerformanceMetrics();
    expect(output).not.toContain('request-test');
    expect(output).not.toContain('user_id=');
    expect(output).not.toContain('userId=');
  });
});
