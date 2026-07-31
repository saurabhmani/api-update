import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cacheKeys } from '@/lib/cache/cacheKeys';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const dashboardRoute = read('src/app/api/dashboard/route.ts');
const dashboardPage = read('src/app/dashboard/page.tsx');
const dexterRoute = read('src/app/api/signal-engine/dexter/route.ts');
const dexterPage = read('src/app/dexter/page.tsx');
const profiler = read('src/lib/api/requestStageProfiler.ts');

describe('Dashboard and Dexter performance contracts', () => {
  it('keeps cache entries isolated by user', () => {
    expect(cacheKeys.dashboardSummary(1)).not.toBe(cacheKeys.dashboardSummary(2));
    expect(cacheKeys.dexterIntelligence(1, 7, null, null))
      .not.toBe(cacheKeys.dexterIntelligence(2, 7, null, null));
  });

  it('profiles dashboard authentication, cache, dependencies and serialization', () => {
    for (const stage of [
      'authentication', 'cache_lookup', 'dashboard_dependencies',
      'market_status', 'response_processing', 'serialization',
    ]) expect(dashboardRoute).toContain(`'${stage}'`);
  });

  it('profiles Dexter context separately and caches empty results briefly', () => {
    for (const stage of [
      'authentication', 'request_validation', 'cache_lookup',
      'signals_loading', 'AI_context_loading', 'serialization',
    ]) expect(dexterRoute).toContain(`'${stage}'`);
    expect(dexterRoute).toContain('CACHE_POLICIES.dexterEmpty');
    expect(dexterRoute).not.toContain('ensureSignalEngineSchemas()');
  });

  it('deduplicates Dexter context before narrative construction', () => {
    expect(dexterRoute).toContain('const newsBySymbol = new Map');
    expect(dexterRoute).toContain('const feedbackByIdentity = new Map');
    expect(dexterRoute.indexOf("await profile.time('AI_context_loading'"))
      .toBeLessThan(dexterRoute.indexOf('const intelligence: DexterSignalIntelligence[]'));
  });

  it('guards initial frontend requests and avoids polling over live SSE', () => {
    expect(dashboardPage).toContain('if (initialLoadStartedRef.current) return');
    expect(dashboardPage).toContain('if (requestInFlightRef.current) return');
    expect(dexterPage).toContain('if (loadedIdentityRef.current === identity) return');
    expect(dexterPage).toContain('if (!document.hidden && !connected) load(false)');
    expect(dexterPage).toContain('requestControllerRef.current?.abort()');
  });

  it('ranks slow steps at all requested thresholds without sensitive fields', () => {
    for (const threshold of ['1_000', '500', '250', '100', '50', '20']) {
      expect(profiler).toContain(threshold);
    }
    expect(profiler).not.toMatch(/cookie|authorization|apiKey|brokerToken|rawPrompt/i);
  });
});
