import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cacheKeys } from '@/lib/cache/cacheKeys';

const routeSource = readFileSync(
  resolve(process.cwd(), 'src/app/api/signals/route.ts'),
  'utf8',
);
const serviceSource = readFileSync(
  resolve(process.cwd(), 'src/lib/signals/confirmedSignalsService.ts'),
  'utf8',
);
const repositorySource = readFileSync(
  resolve(process.cwd(), 'src/lib/signal-engine/repository/readConfirmedSnapshots.ts'),
  'utf8',
);
const clientSource = readFileSync(
  resolve(process.cwd(), 'src/app/signals/useSignalsPolling.ts'),
  'utf8',
);
const profilerSource = readFileSync(
  resolve(process.cwd(), 'src/lib/signals/signalsApiProfiler.ts'),
  'utf8',
);
const metricsSource = readFileSync(
  resolve(process.cwd(), 'src/lib/monitor/apiPerformanceMetrics.ts'),
  'utf8',
);
const redisSource = readFileSync(
  resolve(process.cwd(), 'src/lib/redis.ts'),
  'utf8',
);

describe('signals API performance contracts', () => {
  it('builds isolated response cache keys for different users', () => {
    const a = cacheKeys.signalsResponse(101, 'top', 50, false, '2026-07-31:open');
    const b = cacheKeys.signalsResponse(202, 'top', 50, false, '2026-07-31:open');

    expect(a).not.toBe(b);
    expect(a).toMatch(/:user-[a-f0-9]+:/);
    expect(b).toMatch(/:user-[a-f0-9]+:/);
  });

  it('uses the centralized Redis cache before loading the live bundle', () => {
    expect(routeSource.indexOf('cacheService.get<Record<string, unknown>>'))
      .toBeLessThan(routeSource.indexOf('loadConfirmedSignalsBundle({'));
    expect(profilerSource).toContain("response.headers.set('X-Cache'");
    expect(routeSource).toContain('CACHE_POLICIES.signalsList');
  });

  it('bypasses cache for operator freshness modes and avoids caching empty live results', () => {
    expect(routeSource).toContain('!bootstrap && !noCache && !debugSignals');
    expect(routeSource).toContain('const cacheablePayload =');
    expect(routeSource).toContain('cacheablePayload\n        && responseCacheKey');
  });

  it('profiles major I/O and response stages', () => {
    for (const step of [
      'authentication',
      'request_validation',
      'market_status_detection',
      'redis_lookup',
      'database_queries',
      'market_data_fetch',
      'signal_processing_ranking_filtering',
      'pagination',
      'response_serialization',
    ]) {
      expect(`${routeSource}\n${serviceSource}`).toContain(`'${step}'`);
    }
  });

  it('consolidates snapshot metadata and runs independent reads in parallel', () => {
    expect(serviceSource).toContain('getConfirmedSnapshotReadMeta()');
    expect(serviceSource).toContain('const loadDatabase = () => Promise.all([');
    expect(repositorySource).toContain('export async function getConfirmedSnapshotReadMeta');
    expect(repositorySource).toContain("SUM(status='ACTIVE' AND valid_until>NOW())");
  });

  it('reuses request market state for both enrichment calls', () => {
    expect(serviceSource).toContain('opts.marketOpen ?? getMarketStatus().isOpen');
    expect(serviceSource).toContain('marketOpen: marketIsOpen');
  });

  it('batches snapshots and trackers into one provider request with timeout protection', () => {
    expect(serviceSource).toContain('const combinedRows = [...snapshotRows, ...trackerRows]');
    expect(serviceSource).toContain('enrichWithLiveLtpDetailed(combinedRows, enrichOpts)');
    expect(serviceSource).toContain('providerCalls: shouldEnrichLive ? 1 : 0');
    expect(serviceSource).toContain('Promise.race([');
    expect(serviceSource).toContain('resolveBatch(symbols, { quiet: true })');
  });

  it('profiles processing stages and avoids the strict filter-map-filter chain', () => {
    expect(serviceSource).toContain("'confidence_scoring_filtering'");
    expect(serviceSource).toContain("'ranking_sorting_maturity'");
    expect(serviceSource).toContain('for (const row of enriched)');
    expect(serviceSource).not.toContain('const strictAudit = enriched.map');
  });

  it('performs one automatic HTTP signals load and relies on SSE thereafter', () => {
    expect(clientSource).toContain('if (pollStartedRef.current) return');
    expect(clientSource).toContain('SSE/WebSocket updates own live refreshes after the single HTTP load');
    expect(clientSource).not.toContain('autoRefreshIfStale();');
    expect(clientSource).not.toContain('\n    arm();');
  });

  it('keeps unexpected errors sanitized', () => {
    expect(routeSource).toContain("NextResponse.json({ error: 'Server error' }");
    expect(routeSource).not.toContain("details: err instanceof Error ? err.message");
  });

  it('parallelizes independent closed-market reads', () => {
    expect(routeSource).toContain("'closed_market_parallel_reads'");
    expect(routeSource).toContain('() => Promise.all([');
    expect(routeSource).toContain('probeLatestCandleMs().catch');
    expect(routeSource).toContain('loadClosedMarketSignals({ limit }).catch');
  });

  it('ranks slow steps at the required thresholds', () => {
    expect(profilerSource).toContain('.filter((step) => step.durationMs >= 20)');
    for (const threshold of [20, 50, 100, 250, 500]) {
      expect(profilerSource).toContain(`step.durationMs >= ${threshold}`);
    }
    expect(profilerSource).toContain('slowSteps,');
  });

  it('exports Signals metrics and development-only timing headers', () => {
    for (const metric of [
      'signals_request_ms',
      'signals_db_ms',
      'signals_cache_ms',
      'signals_provider_ms',
      'signals_processing_ms',
      'signals_payload_size',
      'signals_cache_hit',
      'signals_cache_miss',
    ]) {
      expect(metricsSource).toContain(metric);
    }
    expect(profilerSource).toContain("process.env.NODE_ENV === 'development'");
    for (const header of ['X-Response-Time', 'X-Cache', 'X-DB-Time', 'X-Provider-Time']) {
      expect(profilerSource).toContain(header);
    }
  });

  it('preserves Redis TTL when warming the in-process cache and serializes once', () => {
    expect(redisSource).toContain('.pipeline().get(key).pttl(key).exec()');
    expect(redisSource).toContain('memSetSerialized(key, val, ttlSeconds)');
    expect(redisSource).toContain('const val = JSON.stringify(data)');
    expect(redisSource).not.toContain('memSet(key, parsed)');
  });
});
