import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync('src/app/api/trade-setups/route.ts', 'utf8');
const page = readFileSync('src/app/trade-setups/page.tsx', 'utf8');
const schema = readFileSync('src/lib/db/migrateIntelligence.ts', 'utf8');

describe('trade setup API optimization contracts', () => {
  it('validates session, symbol, timeframe, strategy, and ownership', () => {
    expect(route).toContain('requireSession()');
    expect(route).toContain('SYMBOL_PATTERN');
    expect(route).toContain('ALLOWED_TIMEFRAMES');
    expect(route).toContain('getRegistryEntry(strategyId)');
    expect(route).toContain('resolveAuthorizedInstrument');
    expect(route).toContain('w.user_id=?');
    expect(route).toContain('p.user_id=?');
    // Prevent ER_CANT_AGGREGATE_NCOLLATIONS across mixed table collations.
    expect(route).toContain('COLLATE utf8mb4_unicode_ci');
  });

  it('uses deterministic identity dimensions and idempotent persistence', () => {
    expect(route).toContain('ENGINE_VERSION');
    expect(route).toContain('freshnessVersion');
    expect(route).toContain('marketContext');
    expect(route).toContain('ON DUPLICATE KEY UPDATE');
    expect(schema).toContain('UNIQUE KEY uq_ts_generation');
  });

  it('uses resolver policy, timeouts, cache, locking, and coalescing', () => {
    expect(route).toContain("from '@/lib/marketData/resolver/marketDataResolver'");
    expect(route).toContain('PROVIDER_TIMEOUT_MS');
    expect(route).toContain('DATABASE_TIMEOUT_MS');
    expect(route).toContain('cacheService.get');
    expect(route).toContain('cacheService.set');
    expect(route).toContain('cacheAcquireDistributedLock');
    expect(route).toContain('const inFlight = new Map');
  });

  it('adds request observability and safe errors', () => {
    expect(route).toContain('withApiHandler(handlePost)');
    expect(route).toContain("log.info('Generation request completed'");
    expect(route).toContain('Market data provider timed out. Please retry.');
    expect(route).not.toMatch(/error:\s*(error|err)\.message\b/);
  });

  it('never asks the generation endpoint for a full-universe scan', () => {
    expect(page).toContain('/api/rankings?limit=1&page=1');
    expect(page).toContain('symbol,');
    expect(route).not.toContain('syncRankingsFromNse');
    expect(route).not.toContain('for (const inst of ranked)');
  });
});
