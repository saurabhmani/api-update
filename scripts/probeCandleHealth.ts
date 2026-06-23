/**
 * Candle warehouse health + historical coverage probe.
 *
 * Usage:
 *   npx tsx scripts/probeCandleHealth.ts
 *
 * Loads .env.local automatically (same as diagnoseUniverse.ts).
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { getMarketStatus } from '../src/lib/marketData/marketHours';
import { classifyCandleFreshness } from '../src/lib/marketData/candleFreshness';
import { probeEngineHealthStatus } from '../src/lib/monitor/engineHealthProbe';
import { buildLightweightEngineHealthPreview } from '../src/lib/signals/engineHealthMap';

const WARMUP_BARS_DEFAULT = 100;
const INDICATOR_MIN_BARS = 60;
const EMA200_MIN_BARS = 200;

export interface SymbolBarCount {
  symbol:   string;
  barCount: number;
}

export interface CoverageAssessment {
  totalSymbols:              number;
  averageBarsPerSymbol:      number;
  symbolsWithAtLeast60Bars:  number;
  symbolsWithAtLeast200Bars: number;
  symbolsBelow60Bars:      number;
  symbolsBelowWarmup100:   number;
  coverageDeficiency:        boolean;
  deficiencySummary:         string;
}

/** Pure assessment — used by the probe script and vitest. */
export function assessCoverageStats(rows: SymbolBarCount[]): CoverageAssessment {
  const totalSymbols = rows.length;
  const barCounts = rows.map((r) => r.barCount);
  const sum = barCounts.reduce((acc, n) => acc + n, 0);
  const averageBarsPerSymbol = totalSymbols > 0
    ? Math.round((sum / totalSymbols) * 10) / 10
    : 0;
  const symbolsWithAtLeast60Bars  = barCounts.filter((n) => n >= INDICATOR_MIN_BARS).length;
  const symbolsWithAtLeast200Bars = barCounts.filter((n) => n >= EMA200_MIN_BARS).length;
  const symbolsBelow60Bars    = totalSymbols - symbolsWithAtLeast60Bars;
  const symbolsBelowWarmup100 = barCounts.filter((n) => n < WARMUP_BARS_DEFAULT).length;
  // "Many" = majority of active universe symbols under the indicator floor.
  const coverageDeficiency = totalSymbols > 0 && symbolsBelow60Bars > totalSymbols / 2;
  const pctBelow60 = totalSymbols > 0
    ? Math.round((symbolsBelow60Bars / totalSymbols) * 1000) / 10
    : 0;
  const deficiencySummary = coverageDeficiency
    ? `${symbolsBelow60Bars}/${totalSymbols} universe symbols (${pctBelow60}%) have fewer than ${INDICATOR_MIN_BARS} EOD bars — backtest health degraded.`
    : totalSymbols === 0
      ? 'No active universe symbols found — cannot assess coverage.'
      : `Coverage acceptable: ${symbolsWithAtLeast60Bars}/${totalSymbols} symbols meet the ${INDICATOR_MIN_BARS}-bar indicator floor.`;

  return {
    totalSymbols,
    averageBarsPerSymbol,
    symbolsWithAtLeast60Bars,
    symbolsWithAtLeast200Bars,
    symbolsBelow60Bars,
    symbolsBelowWarmup100,
    coverageDeficiency,
    deficiencySummary,
  };
}

export async function probeHistoricalCoverage(): Promise<CoverageAssessment> {
  // Pre-aggregate once on market_data_daily, then join the small derived
  // table to the active universe (~502 rows). Avoids counting millions of
  // raw rows per universe symbol (slow) or scanning all warehouse symbols
  // into the backtest coverage verdict (misleading — backtest uses universe).
  const { rows } = await db.query<{ symbol: string; bar_cnt: number }>(`
    SELECT UPPER(u.symbol) AS symbol, COALESCE(d.bar_cnt, 0) AS bar_cnt
    FROM q365_universe u
    LEFT JOIN (
      SELECT symbol, COUNT(*) AS bar_cnt
      FROM market_data_daily
      GROUP BY symbol
    ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
    WHERE u.is_active = 1
  `);
  return assessCoverageStats(
    (rows ?? []).map((r) => ({
      symbol:   String(r.symbol ?? ''),
      barCount: Number(r.bar_cnt ?? 0),
    })),
  );
}

async function main() {
  const market = getMarketStatus();
  let latestMs: number | null = null;
  let coverage: CoverageAssessment | null = null;
  let coverageError: string | null = null;

  try {
    const r = await db.query('SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily');
    const ts = (r.rows[0] as { ts?: number | string | null })?.ts;
    if (ts != null) latestMs = Number(ts) * 1000;
  } catch (e) {
    console.error('db err', e);
  }

  try {
    coverage = await probeHistoricalCoverage();
  } catch (e) {
    coverageError = (e as Error).message ?? 'coverage probe failed';
    console.error('coverage err', e);
  }

  const ageHours = latestMs ? (Date.now() - latestMs) / 3_600_000 : null;
  const report = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open:      market.isOpen,
    candle_source:    'daily',
  });

  const ageMinutes = ageHours != null ? Math.round(ageHours * 60) : null;
  const preview = buildLightweightEngineHealthPreview({
    marketOpen:       market.isOpen,
    isBootstrap:      false,
    isFallback:       false,
    staleMinutes:     ageMinutes,
    freshnessMode:    report.freshness_mode,
    feedFrozen:       report.feed_frozen,
    freshnessQuality: report.freshness_quality,
    approvedTotal:    0,
    candidateTotal:   5,
  });

  const probe = await probeEngineHealthStatus();
  
  console.log(JSON.stringify({
    market,
    latestIso:  latestMs ? new Date(latestMs).toISOString() : null,
    ageHours:   ageHours?.toFixed(1) ?? null,
    candleReport: report,
    coverage:   coverage ?? null,
    coverageError,
    healthPreview: preview,
    institutionalProbe: probe,
  }, null, 2));

  // CLI scripts must exit explicitly — mysql2 pool keeps the event loop alive.
  process.exit(coverageError ? 1 : 0);
}

const isMain = process.argv[1]?.includes('probeCandleHealth');
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
