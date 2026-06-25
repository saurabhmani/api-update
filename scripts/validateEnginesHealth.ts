/**
 * validateEnginesHealth.ts — offline engine + data-flow health matrix.
 *
 * Probes warehouse coverage, reporting adapters, and health-map rules
 * without starting the Next.js server. For live HTTP checks use:
 *   npm run test:ui-manipulation
 *   scripts/uiValidateDailyReportCompletenessHttp.mjs
 *
 * Usage:
 *   npx tsx scripts/validateEnginesHealth.ts
 */

import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
loadEnv({ path: path.resolve(process.cwd(), '.env') });

import { db } from '@/lib/db';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { probeHistoricalCoverage } from '../scripts/probeCandleHealth';
import {
  getLatestEodTradeDateInWarehouse,
  getHistoricalMarketMovers,
} from '@/lib/signals/historicalMarketData';
import {
  buildEngineHealthMap,
  type EngineHealthContext,
} from '@/lib/signals/engineHealthMap';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';

type Band = 'OK' | 'WARN' | 'CRIT';

interface Row {
  engine: string;
  band: Band;
  status: string;
  detail: string;
}

const rows: Row[] = [];

function bandIcon(b: Band): string {
  return b === 'OK' ? '✓' : b === 'WARN' ? '⚠' : '✗';
}

function record(engine: string, band: Band, status: string, detail: string): void {
  rows.push({ engine, band, status, detail });
}

async function probeWarehouse(): Promise<{
  latestMs: number | null;
  candleCount: number;
  distinctSymbols: number;
}> {
  try {
    const { rows: r } = await db.query<{
      cnt: number | string;
      latest: string | Date | null;
      symbols: number | string;
    }>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS latest, COUNT(DISTINCT instrument_key) AS symbols
         FROM candles WHERE candle_type='eod' AND interval_unit='1day'`,
    );
    const row = r[0];
    const latestRaw = row?.latest;
    const latestMs = latestRaw == null
      ? null
      : latestRaw instanceof Date
        ? latestRaw.getTime()
        : new Date(latestRaw).getTime();
    return {
      latestMs: Number.isFinite(latestMs) ? latestMs : null,
      candleCount: Number(row?.cnt ?? 0),
      distinctSymbols: Number(row?.symbols ?? 0),
    };
  } catch {
    return { latestMs: null, candleCount: 0, distinctSymbols: 0 };
  }
}

async function main(): Promise<void> {
  const market = getMarketStatus();
  const warehouse = await probeWarehouse();
  const coverage = await probeHistoricalCoverage();
  const latestEod = await getLatestEodTradeDateInWarehouse();
  const movers = latestEod
    ? await getHistoricalMarketMovers(latestEod, { limit: 5 })
    : { available: false, movers: [], warnings: ['no EOD date'] };

  const candleReport = classifyCandleFreshness({
    latest_candle_ms: warehouse.latestMs,
    market_open: market.isOpen,
    candle_source: 'daily',
  });

  // ── Data Feed Engine ─────────────────────────────────────────
  if (warehouse.candleCount === 0) {
    record('Data Feed', 'CRIT', 'INSUFFICIENT_DATA', 'No EOD candles in warehouse');
  } else if (candleReport.freshness_quality === 'stale' && market.isOpen) {
    record('Data Feed', 'WARN', 'STALE', `EOD age ${candleReport.candle_age_seconds ?? '?'}s during session`);
  } else {
    record(
      'Data Feed',
      'OK',
      'HEALTHY',
      `${warehouse.distinctSymbols} symbols, latest EOD ${latestEod ?? '—'}, quality=${candleReport.freshness_quality}`,
    );
  }

  // ── Scanner / Phase 4 (warehouse floor) ──────────────────────
  if (coverage.coverageDeficiency) {
    record('Scanner (candle floor)', 'CRIT', 'DEGRADED', coverage.deficiencySummary);
  } else if (coverage.symbolsBelow60Bars > 10) {
    record(
      'Scanner (candle floor)',
      'WARN',
      'WARNING',
      `${coverage.symbolsBelow60Bars} universe symbols below 60 bars`,
    );
  } else {
    record(
      'Scanner (candle floor)',
      'OK',
      'HEALTHY',
      `${coverage.symbolsWithAtLeast60Bars}/${coverage.totalSymbols} symbols ≥60 bars`,
    );
  }

  // ── Daily Report (movers adapter) ────────────────────────────
  if (!movers.available) {
    record('Daily Report (movers)', 'WARN', 'INSUFFICIENT_DATA', movers.warnings.join('; ') || 'no movers');
  } else {
    const moverDate = 'date' in movers ? movers.date : latestEod ?? '—';
    record(
      'Daily Report (movers)',
      'OK',
      'COMPLETE',
      `${movers.movers.length} movers on ${moverDate}`,
    );
  }

  // ── Backtesting (EOD adapter) ────────────────────────────────
  const sampleSym = 'RELIANCE';
  const { getHistoricalCandles } = await import('@/lib/signals/historicalMarketData');
  const end = latestEod ?? new Date().toISOString().slice(0, 10);
  const startD = new Date(end);
  startD.setUTCDate(startD.getUTCDate() - 6);
  const start = startD.toISOString().slice(0, 10);
  const sample = await getHistoricalCandles(sampleSym, `${start} 00:00:00`, `${end} 23:59:59`, '1day');
  if (!sample.available) {
    record('Backtesting (EOD lookup)', 'CRIT', 'INSUFFICIENT_DATA', `No 1day candles for ${sampleSym}`);
  } else {
    record(
      'Backtesting (EOD lookup)',
      'OK',
      'HEALTHY',
      `${sampleSym}: ${sample.candles.length} bar(s) in ${start}…${end}`,
    );
  }

  // ── Engine Health Map (synthetic ctx) ──────────────────────
  const ctx: EngineHealthContext = {
    generatedAt: new Date().toISOString(),
    marketStatus: { isOpen: market.isOpen, label: market.label, state: market.state },
    feed: {
      provider: 'candles_warehouse',
      lastSuccessAt: warehouse.latestMs ? new Date(warehouse.latestMs).toISOString() : null,
      lastApiRequestAt: null,
      isBootstrap: false,
      isFallback: false,
      staleMinutes: candleReport.candle_age_seconds != null
        ? Math.round(candleReport.candle_age_seconds / 60)
        : null,
      freshnessLabel: candleReport.freshness_quality,
      coveragePercent: coverage.totalSymbols > 0
        ? Math.round((coverage.symbolsWithAtLeast60Bars / coverage.totalSymbols) * 100)
        : null,
      symbolsRequested: coverage.totalSymbols,
      symbolsReturned: coverage.symbolsWithAtLeast60Bars,
      candleAgeHours: candleReport.candle_age_seconds != null
        ? Math.round(candleReport.candle_age_seconds / 360) / 10
        : null,
      candleCoverage: {
        latestCandleDate: latestEod,
        candleCount: warehouse.candleCount,
        distinctSymbols: warehouse.distinctSymbols,
      },
    },
    transport: {
      signalsAvailable: false,
      dailyReportAvailable: movers.available,
      backtestAvailable: sample.available,
    },
    pipeline: {
      lastPipelineRunAt: null,
      lastConfirmedSignalAt: null,
      latestBatchId: null,
      latestBatchEngineKind: null,
      scanCoveragePercent: null,
      totalScanned: null,
      totalPersisted: null,
      universeSize: coverage.totalSymbols,
      inProgressCount: null,
      validationStatus: null,
    },
    signals: {
      approved: [], highPotential: [], watchlist: [], developing: [],
      scannerCandidates: [], riskRestricted: [], rejected: [],
    },
    counters: {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
    },
    dueDiligenceSummary: null,
    dailyReport: {
      available: movers.available,
      reportStatus: movers.available ? 'PARTIAL' : 'INSUFFICIENT_DATA',
      generatedAt: new Date().toISOString(),
      warnings: movers.available ? [] : ['movers unavailable'],
    },
    backtest: {
      available: sample.available,
      status: sample.available ? 'PARTIAL' : 'INSUFFICIENT_DATA',
      window: '7D',
      generatedAt: new Date().toISOString(),
      symbolsWithData: sample.available ? 1 : 0,
      totalSymbols: 1,
      warnings: [],
    },
  };

  const map = buildEngineHealthMap(ctx);
  const SIGNAL_PLANE_IDS = new Set([
    'indicators', 'scoring', 'risk', 'manipulation', 'confirmation',
    'due_diligence', 'daily_report', 'backtesting', 'learning',
  ]);
  for (const node of map.nodes) {
    if (node.id === 'learning') continue;
    const offlineSignalPlane = SIGNAL_PLANE_IDS.has(node.id);
    if (offlineSignalPlane) {
      record(
        `Health Map · ${node.name}`,
        'WARN',
        'NEEDS_LIVE_SIGNALS',
        'Run with server: GET /api/signals/engine-health',
      );
      continue;
    }
    const band: Band =
      node.status === 'HEALTHY' ? 'OK'
      : node.status === 'BROKEN' || node.status === 'INSUFFICIENT_DATA' ? 'CRIT'
      : 'WARN';
    record(
      `Health Map · ${node.name}`,
      band,
      node.status,
      node.diagnostics.primaryIssue ?? node.diagnostics.warnings[0] ?? 'operational',
    );
  }

  console.log('\n═══ ENGINE HEALTH MATRIX (offline) ═══\n');
  console.log(`Market: ${market.label}  ·  IST ${market.nowIst}\n`);
  for (const r of rows) {
    console.log(`  ${bandIcon(r.band)}  ${r.engine.padEnd(28)} ${r.status.padEnd(18)} ${r.detail}`);
  }

  const crit = rows.filter((r) => r.band === 'CRIT').length;
  const warn = rows.filter((r) => r.band === 'WARN').length;
  const ok   = rows.filter((r) => r.band === 'OK').length;
  console.log('\n── Summary ─────────────────────────────');
  console.log(`  Data plane:  OK=${ok}  WARN=${warn}  CRIT=${crit}`);
  console.log(`  Health map (synthetic): ${map.overallStatus}`);
  console.log('\n  Signal-plane nodes need a live /api/signals envelope — not a data defect.');
  console.log('\nLive checks (server required):');
  console.log('  GET /api/signals/engine-health');
  console.log('  GET /api/signals/daily-report');
  console.log('  GET /api/signals/backtest?window=7D');
  console.log('');

  process.exit(crit > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[validateEnginesHealth] fatal:', e);
  process.exit(2);
});
