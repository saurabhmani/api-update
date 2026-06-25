/**
 * Daily report ↔ market movers integration (Phase 4B).
 *
 * Tests 3.1–3.4 — acceptance against live `candles` when DB is configured.
 */
import './loadEnv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  buildDailySignalReport,
  buildMissedOpportunities,
  type DailyReportInput,
} from '@/lib/signals/dailySignalReport';
import { getHistoricalMarketMovers } from '@/lib/signals/historicalMarketData';

const REPORT_DATE = '2026-06-23';
const PLACEHOLDER_NOT_CONFIGURED = 'Market movers dataset not configured';
const PLACEHOLDER_NOT_AVAILABLE = 'Market movers dataset is not available yet';

function minimalInput(overrides: Partial<DailyReportInput> = {}): DailyReportInput {
  return {
    reportDate: REPORT_DATE,
    marketStatus: { isOpen: false, label: 'Closed' },
    signals: {
      approved:          [],
      highPotential:     [],
      watchlist:         [],
      developing:        [],
      scannerCandidates: [],
      riskRestricted:    [],
      rejected:          [],
    },
    dataQuality: {
      provider:          'test',
      lastSuccessAt:     null,
      staleMinutes:      null,
      symbolsRequested:  null,
      symbolsReturned:   null,
      coveragePercent:   null,
      isBootstrap:       false,
      isFallback:        false,
      freshnessLabel:    null,
    },
    ...overrides,
  };
}

async function resolveTradeDateWithMovers(): Promise<string | null> {
  const { rows } = await db.query<{ trade_date: string | Date }>(
    `SELECT DATE(MAX(ts)) AS trade_date
     FROM candles
     WHERE candle_type = 'eod'
       AND interval_unit = '1day'`,
  );
  const raw = rows[0]?.trade_date;
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

describe('daily report market movers — unit contracts', () => {
  it('without movers — market movers and missed-opportunity sections are INSUFFICIENT_DATA', () => {
    const report = buildDailySignalReport(minimalInput());

    expect(report.marketMoversStatus).toBe('INSUFFICIENT_DATA');
    expect(report.marketMovers).toEqual([]);
    expect(report.missedOpportunitiesStatus).toBe('INSUFFICIENT_DATA');
    expect(report.missedOpportunities).toEqual([]);
  });

  it('with populated movers — report builder consumes movers and clears INSUFFICIENT_DATA', () => {
    const movers = [
      { symbol: 'RELIANCE', movePercent: 8.5, direction: 'UP' as const, volume: 1_200_000, date: REPORT_DATE },
      { symbol: 'TCS', movePercent: -4.2, direction: 'DOWN' as const, volume: 800_000, date: REPORT_DATE },
    ];

    const report = buildDailySignalReport(minimalInput({ marketMovers: movers }));

    expect(report.marketMoversStatus).toBe('COMPLETE');
    expect(report.marketMovers).toHaveLength(2);
    expect(report.missedOpportunitiesStatus).not.toBe('INSUFFICIENT_DATA');
  });

  it('approved movers are excluded from missed opportunities but still appear in market movers', () => {
    const movers = [{ symbol: 'WINNER', movePercent: 5, direction: 'UP' as const }];
    const input = minimalInput({
      marketMovers: movers,
      signals: {
        ...minimalInput().signals,
        approved: [{ symbol: 'WINNER', tradingsymbol: 'WINNER' } as never],
      },
    });

    const report = buildDailySignalReport(input);

    expect(report.marketMovers).toHaveLength(1);
    expect(report.missedOpportunitiesStatus).toBe('PARTIAL');
    expect(report.missedOpportunities).toEqual([]);
  });
});

describe('Test 3 — daily report market movers acceptance', () => {
  let tradeDate: string | null = null;
  let moversResult: Awaited<ReturnType<typeof getHistoricalMarketMovers>> | null = null;
  let report: ReturnType<typeof buildDailySignalReport> | null = null;

  beforeAll(async () => {
    tradeDate = await resolveTradeDateWithMovers();
    if (!tradeDate) return;

    moversResult = await getHistoricalMarketMovers(tradeDate, { limit: 20 });
    if (!moversResult.available) return;

    report = buildDailySignalReport(minimalInput({
      reportDate: tradeDate,
      marketMovers: moversResult.movers.map((m) => ({
        symbol:      m.symbol,
        movePercent: m.movePercent,
        direction:   m.direction,
        volume:      m.volume,
        date:        m.date,
      })),
    }));
  }, 60_000);

  it('3.1 — generated daily report contains marketMovers records', () => {
    expect(tradeDate, 'candles table must have at least one EOD trade date with movers').toBeTruthy();
    expect(moversResult?.available).toBe(true);
    expect(moversResult!.movers.length).toBeGreaterThan(0);

    const payload = { marketMovers: report!.marketMovers };
    expect(payload.marketMovers.length).toBeGreaterThan(0);
    expect(payload.marketMovers[0]).toMatchObject({
      symbol:      expect.any(String),
      movePercent: expect.any(Number),
      direction:   expect.stringMatching(/^(UP|DOWN)$/),
    });
    expect(report!.marketMoversStatus).toBe('COMPLETE');
  });

  it('3.2 — "Market movers dataset not configured" no longer appears when movers exist', () => {
    expect(report).toBeTruthy();

    const serialised = JSON.stringify({
      report,
      warnings: moversResult!.warnings,
      missedOpportunitiesStatus: report!.missedOpportunitiesStatus,
    });

    expect(serialised).not.toContain(PLACEHOLDER_NOT_CONFIGURED);
    expect(serialised).not.toContain(PLACEHOLDER_NOT_AVAILABLE);
    expect(report!.missedOpportunitiesStatus).not.toBe('INSUFFICIENT_DATA');
    expect(moversResult!.warnings.join(' ')).not.toContain(PLACEHOLDER_NOT_CONFIGURED);

    const { status } = buildMissedOpportunities(minimalInput({
      reportDate: tradeDate!,
      marketMovers: moversResult!.movers,
    }));
    expect(status).not.toBe('INSUFFICIENT_DATA');
  });

  it('3.3 — top gainers and losers are visible in report data', () => {
    expect(report!.marketMovers!.length).toBeGreaterThan(0);

    const gainers = report!.marketMovers!.filter((m) => m.direction === 'UP');
    const losers = report!.marketMovers!.filter((m) => m.direction === 'DOWN');

    expect(gainers.length).toBeGreaterThan(0);
    expect(losers.length).toBeGreaterThan(0);

    const pageSource = readFileSync(
      resolve(process.cwd(), 'src/app/signals/daily-report/page.tsx'),
      'utf8',
    );
    expect(pageSource).toContain('Top Gainers');
    expect(pageSource).toContain('Top Losers');
    expect(pageSource).toContain('MarketMoversTable');
  });

  it('3.4 — volume field populated on market movers', () => {
    expect(report!.marketMovers!.length).toBeGreaterThan(0);

    const withVolume = report!.marketMovers!.filter(
      (m) => m.volume != null && Number.isFinite(m.volume) && m.volume > 0,
    );
    expect(withVolume.length).toBeGreaterThan(0);

    for (const mover of report!.marketMovers!) {
      expect(mover).toHaveProperty('volume');
      expect(mover.volume === null || typeof mover.volume === 'number').toBe(true);
    }
  });
});
