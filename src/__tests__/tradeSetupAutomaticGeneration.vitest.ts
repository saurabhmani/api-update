import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/app/trade-setups/page.tsx', 'utf8');
const route = readFileSync('src/app/api/trade-setups/route.ts', 'utf8');
const redis = readFileSync('src/lib/redis.ts', 'utf8');

describe('trade setup automatic generation contracts', () => {
  it('uses an enabled React Query read with cancellation and stable freshness', () => {
    expect(page).toContain('useQuery({');
    expect(page).toContain('enabled: Boolean(!authLoading && user)');
    expect(page).toContain('signal,');
    expect(page).toContain('staleTime: 30_000');
    expect(page).toContain('refetchOnWindowFocus: false');
  });

  it('guards automatic generation by a stable identity', () => {
    expect(page).toContain('automaticIdentityRef.current === automaticIdentity');
    expect(page).toContain('automaticIdentityRef.current = automaticIdentity');
    expect(page).toContain('generateMutation.mutate({ force: false, symbol: targetSymbol })');
  });

  it('does not generate before authentication, seed data, and symbol are ready', () => {
    expect(page).toContain('enabled: Boolean(!authLoading && user)');
    expect(page).toContain('tradeSetupQuery.isSuccess');
    expect(page).toContain('!automaticIdentity');
    expect(page).toContain('!tradeSetupQuery.isSuccess');
    expect(page).toContain('!targetSymbol');
  });

  it('uses symbol, strategy, and timeframe in the generation identity and key', () => {
    expect(page).toContain("`${user.id}:${targetSymbol}:auto:swing`");
    expect(page).toContain(
      "mutationKey: ['trade-setup', 'generate', targetSymbol, 'auto', 'swing']",
    );
  });

  it('renders loading, error, retry, empty, and success states', () => {
    expect(page).toContain('{loading ? <Loading /> : error ?');
    expect(page).toContain('Trade setups could not be loaded');
    expect(page).toContain('tradeSetupQuery.refetch()');
    expect(page).toContain('generateMutation.mutate({ force: false');
    expect(page).toContain('No active setups');
    expect(page).toContain('setups.map((s: any)');
    expect(page).toContain('setup-card__symbol');
  });

  it('prevents rerender and Strict Mode duplication with client and server guards', () => {
    expect(page).toContain('automaticIdentityRef.current === automaticIdentity');
    expect(page).toContain('automaticIdentityRef.current = automaticIdentity');
    expect(route).toContain('ON DUPLICATE KEY UPDATE');
    expect(route).toContain('const existing = inFlight.get(identity)');
    expect(route).toContain('cacheAcquireDistributedLock');
  });

  it('supports explicit regeneration and actionable errors', () => {
    expect(page).toContain('generateMutation.mutate({ force: true, symbol: targetSymbol })');
    expect(page).toContain('Trade setups could not be loaded');
    expect(page).toContain('Retry');
    expect(page).toContain('setNote(null)');
  });

  it('coalesces server generation and reuses fresh closed-market results', () => {
    expect(route).toContain('cacheAcquireDistributedLock');
    expect(route).toContain('tradeSetupRequestLock');
    expect(route).toContain("generationStatus: 'in_progress'");
    expect(route).toContain('market.isOpen');
    expect(route).toContain('ttlSeconds: 60 * 60');
    expect(redis).toContain("'NX'");
  });

  it('bypasses the cached generation result only for explicit force', () => {
    expect(route).toContain('if (request.force)');
    expect(route).toContain('await cacheService.delete(resultKey)');
    expect(route).toContain("'X-Cache': 'HIT'");
  });
});
