import { describe, expect, it } from 'vitest';
import {
  buildConfiguredSourcesSnapshot,
  buildProviderHealthMap,
  buildSourceHealthSummary,
  enrichSourceHealth,
  mergeRunBreakdown,
} from '@/lib/news-engine/health/newsSourceHealth';

describe('newsSourceHealth', () => {
  it('marks paid sources without env as optional', () => {
    const row = enrichSourceHealth({
      source: 'gnews',
      configured: false,
      fetched: 0,
      error: null,
      lastFetchedAt: null,
    });
    expect(row.healthState).toBe('optional');
    expect(row.healthMessage).toContain('Optional');
  });

  it('marks exchange source as active when items were fetched', () => {
    const row = enrichSourceHealth({
      source: 'official_exchange',
      configured: true,
      fetched: 12,
      error: null,
      lastFetchedAt: '2026-06-24T10:00:00.000Z',
    });
    expect(row.healthState).toBe('active');
    expect(row.status).toBe('HEALTHY');
    expect(row.tier).toBe('official');
  });

  it('builds provider health map with HEALTHY official_exchange', () => {
    const rows = [
      enrichSourceHealth({
        source: 'official_exchange',
        configured: true,
        fetched: 5,
        error: null,
        lastFetchedAt: '2026-06-24T10:00:00.000Z',
      }),
    ];
    expect(buildProviderHealthMap(rows)).toEqual({
      official_exchange: { status: 'HEALTHY' },
    });
  });

  it('marks exchange as configured before first pipeline run', () => {
    const prevBse = process.env.BSE_ANNOUNCEMENTS_RSS;
    const prevNse = process.env.NSE_ANNOUNCEMENTS_RSS;
    process.env.BSE_ANNOUNCEMENTS_RSS = 'https://api.bseindia.com/test';
    process.env.NSE_ANNOUNCEMENTS_RSS = 'https://www.nseindia.com/api/test';
    try {
      const snapshot = buildConfiguredSourcesSnapshot();
      const health = mergeRunBreakdown(snapshot, {}, null);
      const exchange = health.sources.find((s) => s.source === 'official_exchange');
      expect(exchange?.configured).toBe(true);
      expect(exchange?.healthState).toBe('configured');
    } finally {
      if (prevBse === undefined) delete process.env.BSE_ANNOUNCEMENTS_RSS;
      else process.env.BSE_ANNOUNCEMENTS_RSS = prevBse;
      if (prevNse === undefined) delete process.env.NSE_ANNOUNCEMENTS_RSS;
      else process.env.NSE_ANNOUNCEMENTS_RSS = prevNse;
    }
  });

  it('marks exchange unavailable after a silent run', () => {
    const prevBse = process.env.BSE_ANNOUNCEMENTS_RSS;
    const prevNse = process.env.NSE_ANNOUNCEMENTS_RSS;
    process.env.BSE_ANNOUNCEMENTS_RSS = 'https://api.bseindia.com/test';
    process.env.NSE_ANNOUNCEMENTS_RSS = 'https://www.nseindia.com/api/test';
    try {
      const snapshot = buildConfiguredSourcesSnapshot();
      const health = mergeRunBreakdown(
        snapshot,
        { official_exchange: 0 },
        '2026-06-24T10:00:00.000Z',
      );
      const exchange = health.sources.find((s) => s.source === 'official_exchange');
      expect(exchange?.healthState).toBe('unavailable');
      expect(health.warnings.some((w) => w.includes('Exchange announcements'))).toBe(true);
    } finally {
      if (prevBse === undefined) delete process.env.BSE_ANNOUNCEMENTS_RSS;
      else process.env.BSE_ANNOUNCEMENTS_RSS = prevBse;
      if (prevNse === undefined) delete process.env.NSE_ANNOUNCEMENTS_RSS;
      else process.env.NSE_ANNOUNCEMENTS_RSS = prevNse;
    }
  });

  it('marks optional integrations as unavailable but optional', () => {
    for (const source of ['corporate_filings', 'deals_feed', 'social_signals'] as const) {
      const row = enrichSourceHealth({
        source,
        configured: false,
        fetched: 0,
        error: null,
        lastFetchedAt: null,
      });
      expect(row.healthState).toBe('unavailable');
      expect(row.tier).toMatch(/optional/);
      expect(row.healthMessage).toContain('Optional');
      expect(row.healthMessage).toContain('unavailable');
    }
    const health = buildSourceHealthSummary(buildConfiguredSourcesSnapshot());
    expect(health.unavailableSources).toEqual(expect.arrayContaining([
      'corporate_filings', 'deals_feed', 'social_signals',
    ]));
    expect(health.optionalSources).toEqual(expect.arrayContaining([
      'corporate_filings', 'deals_feed', 'social_signals',
    ]));
    expect(health.warnings.some((w) => w.includes('corporate_filings'))).toBe(false);
  });
});
