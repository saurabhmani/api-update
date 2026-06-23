/**
 * getSectorPerformance — Phase 4B deferred backlog (Tests 4.1–4.3).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSectorPerformance } from '@/lib/signals/historicalMarketData';

const SOURCE_PATH = resolve(
  process.cwd(),
  'src/lib/signals/historicalMarketData.ts',
);
const TRADE_DATE = '2026-06-23';

describe('getSectorPerformance — Phase 4B backlog', () => {
  it('4.1 — getSectorPerformance() still compiles and resolves', async () => {
    const result = await getSectorPerformance(TRADE_DATE);

    expect(result).toBeDefined();
    expect(result.date).toBe(TRADE_DATE);
    expect(result).toMatchObject({
      sectors:   expect.any(Array),
      warnings:  expect.any(Array),
      available: expect.any(Boolean),
    });
  });

  it('4.2 — no fake sector data generated', async () => {
    const result = await getSectorPerformance(TRADE_DATE);

    expect(result.sectors).toEqual([]);
    expect(result.available).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Phase 4B backlog');
    expect(result.warnings[0]).not.toMatch(/fabricat|placeholder|mock/i);
  });

  it('4.3 — future implementation path documented in source', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');

    expect(source).toContain('Future implementation path:');
    expect(source).toContain('Sector mapping table not available');
    expect(source).toContain('Nifty sector index');
    expect(source).toContain('getHistoricalMarketMovers()');
    expect(source).toContain('TODO(Phase 4B)');
    expect(source).toContain('buildSectorPerformance()');
  });
});
