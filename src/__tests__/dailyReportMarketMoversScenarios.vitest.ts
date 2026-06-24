/**
 * Daily report market movers — Scenarios A–C (release gate).
 */
import './loadEnv';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  buildDailySignalReport,
  type DailyReportInput,
} from '@/lib/signals/dailySignalReport';
import { getHistoricalMarketMovers } from '@/lib/signals/historicalMarketData';

const REPORT_DATE = '2026-06-23';
const STUB_WARNING = 'Market movers dataset not configured';
const POST_SIGNAL_WARNING =
  'per-signal price history not persisted yet (intraday MFE/MAE and time-to-target unavailable)';

const SCENARIO_C_ALLOWED = [
  /per-signal (price )?history/i,
  /MFE\/MAE/i,
  /time-to-target/i,
  /awaiting post-signal/i,
  /expected platform analytics gap/i,
];

function baseInput(overrides: Partial<DailyReportInput> = {}): DailyReportInput {
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
      lastSuccessAt:     new Date().toISOString(),
      staleMinutes:      5,
      symbolsRequested:  100,
      symbolsReturned:   95,
      coveragePercent:   95,
      isBootstrap:       false,
      isFallback:        false,
      freshnessLabel:    'LIVE',
    },
    ...overrides,
  };
}

async function latestEodTradeDate(): Promise<string | null> {
  const { rows } = await db.query<{ trade_date: string | Date }>(
    `SELECT DATE(MAX(ts)) AS trade_date
     FROM candles
     WHERE candle_type = 'eod' AND interval_unit = '1day'`,
  );
  const raw = rows[0]?.trade_date;
  if (!raw) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  return String(raw).slice(0, 10);
}

describe('Daily report market movers — Scenarios A–C', () => {
  describe('Scenario A — historical candles available', () => {
    let marketMoversAvailable = false;

    beforeAll(async () => {
      const tradeDate = await latestEodTradeDate();
      if (!tradeDate) return;
      const moversResult = await getHistoricalMarketMovers(tradeDate, { limit: 5 });
      marketMoversAvailable = moversResult.available === true && moversResult.movers.length > 0;
    }, 60_000);

    it('returns marketMoversAvailable: true when EOD candles exist', () => {
      expect(marketMoversAvailable).toBe(true);
      expect({ marketMoversAvailable }).toEqual({ marketMoversAvailable: true });
    });
  });

  describe('Scenario B — stub warning removed', () => {
    it('does not emit "Market movers dataset not configured" on daily report', () => {
      const report = buildDailySignalReport(baseInput({
        marketMovers: [
          { symbol: 'TCS', movePercent: -2, direction: 'DOWN', volume: 100, date: REPORT_DATE },
        ],
      }));

      const serialised = JSON.stringify(report);
      expect(serialised).not.toContain(STUB_WARNING);
      expect(serialised).not.toContain('Market movers dataset is not available yet');
      expect(report.marketMoversStatus).toBe('COMPLETE');
    });
  });

  describe('Scenario C — remaining warnings limited to post-signal gaps', () => {
    it('only surfaces per-signal history / MFE/MAE / time-to-target warnings', () => {
      const report = buildDailySignalReport(baseInput({
        marketMovers: [
          { symbol: 'INFY', movePercent: 3, direction: 'UP', volume: 200, date: REPORT_DATE },
        ],
      }));

      expect(report.warnings).toContain(POST_SIGNAL_WARNING);
      expect(report.signalPerformance.insufficientDataReasons).toContain(POST_SIGNAL_WARNING);

      for (const warning of report.warnings) {
        expect(SCENARIO_C_ALLOWED.some((re) => re.test(warning))).toBe(true);
      }
    });

    it('does not mark DATA STALE off-hours when last close snapshot exists', () => {
      const report = buildDailySignalReport(baseInput({
        marketStatus: { isOpen: false, label: 'Closed' },
        dataQuality: {
          provider:          'test',
          lastSuccessAt:     '2026-06-23T10:00:00.000Z',
          staleMinutes:      240,
          symbolsRequested:  100,
          symbolsReturned:   95,
          coveragePercent:   95,
          isBootstrap:       false,
          isFallback:        false,
          freshnessLabel:    '240m ago',
        },
      }));

      expect(report.dataStatus).toBe('LIVE');
      expect(report.dataQuality.warnings.join(' ')).not.toMatch(/Feed stale/i);
    });
  });
});
