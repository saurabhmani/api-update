/**
 * Daily report completeness after market movers implementation.
 */
import './loadEnv';
import { describe, expect, it } from 'vitest';
import {
  buildDailySignalReport,
  type DailyReportInput,
} from '@/lib/signals/dailySignalReport';

const REPORT_DATE = '2026-06-23';
const POST_SIGNAL_REASON =
  'per-signal price history not persisted yet (intraday MFE/MAE and time-to-target unavailable)';

function inputWithMovers(): DailyReportInput {
  return {
    reportDate: REPORT_DATE,
    marketStatus: { isOpen: false, label: 'Closed' },
    signals: {
      approved:          [{ symbol: 'RELIANCE', tradingsymbol: 'RELIANCE' } as never],
      highPotential:     [],
      watchlist:         [],
      developing:        [],
      scannerCandidates: [],
      riskRestricted:    [],
      rejected:          [],
    },
    dataQuality: {
      provider:          'test',
      lastSuccessAt:     new Date().toISOString(),
      staleMinutes:      5,
      symbolsRequested:  100,
      symbolsReturned:   95,
      coveragePercent:   95,
      isBootstrap:       false,
      isFallback:        false,
      freshnessLabel:    'LIVE',
    },
    marketMovers: [
      { symbol: 'TCS', movePercent: -3.5, direction: 'DOWN', volume: 500_000, date: REPORT_DATE },
      { symbol: 'INFY', movePercent: 2.1, direction: 'UP', volume: 400_000, date: REPORT_DATE },
    ],
  };
}

describe('daily report completeness after market movers', () => {
  it('check 1 — market movers available on generated report', () => {
    const report = buildDailySignalReport(inputWithMovers());

    expect(report.marketMoversStatus).toBe('COMPLETE');
    expect(report.marketMovers?.length).toBeGreaterThan(0);
    expect(report.missedOpportunitiesStatus).not.toBe('INSUFFICIENT_DATA');
  });

  it('check 2 — daily report core sections populated', () => {
    const report = buildDailySignalReport(inputWithMovers());

    expect(report.executiveSummary.headline).toBeTruthy();
    expect(report.signalPerformance.approvedTotal).toBe(1);
    expect(report.missedOpportunities.length).toBeGreaterThan(0);
    expect(report.reportStatus).toBe('COMPLETE');
  });

  it('check 3 — market movers warnings removed from report payload', () => {
    const report = buildDailySignalReport(inputWithMovers());
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain('Market movers dataset not configured');
    expect(serialised).not.toContain('Market movers dataset is not available yet');
    expect(report.warnings.join(' ')).not.toMatch(/market movers/i);
  });

  it('check 4 — post-signal limitations remain accurately reported', () => {
    const report = buildDailySignalReport(inputWithMovers());

    expect(report.signalPerformance.insufficientDataReasons).toContain(POST_SIGNAL_REASON);
    expect(report.sectorPerformance.status).toBe('INSUFFICIENT_DATA');
    expect(report.sectorPerformance.notes[0]).toMatch(/sector/i);

    const allowedThemes = [
      /per-signal price history/i,
      /MFE\/MAE/i,
      /time-to-target/i,
      /outcome data unavailable/i,
    ];
    for (const warning of report.warnings) {
      expect(allowedThemes.some((re) => re.test(warning))).toBe(true);
    }
  });
});
