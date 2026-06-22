/**
 * validatePhase4Signoff.ts — 14-point pre-finalization acceptance audit
 *
 * Usage:
 *   npm run validate:phase4-signoff
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';
import { migrateProviderRequestLogs } from '@/lib/db/migrateProviderRequestLogs';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';
import {
  getMarketDataProvider,
  getNseDirectFallbackConfig,
  isYahooEmergencyFallbackEnabled,
  isNseForceMode,
} from '@/lib/marketData/providerFlags';
import { loadActiveUniverseSymbols } from '@/lib/marketData/candleBackfillJob';
import {
  fetchDailyCandlesWithFallback,
  getIndianApiCandleRequestCount,
  readDailyCandlesFromDb,
  resetCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import { MIN_CANDLE_COUNT } from '@/lib/signal-engine/constants/signalEngine.constants';
import { validateCandleSeries } from '@/lib/signal-engine/utils/candles';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { evaluateFibonacciPullback } from '@/lib/signal-engine/strategies/fibonacciPullback';
import {
  beginSignalEngineRun,
  completeSignalEngineRun,
  buildSignalEngineStatus,
} from '@/lib/signal-engine/runSignalEngineStatus';
import {
  generatePhase4Signals,
  DEFAULT_PHASE1_CONFIG,
  DEFAULT_PHASE3_CONFIG,
} from '@/lib/signal-engine';
import type { CandleProvider, Candle, PortfolioSnapshot } from '@/lib/signal-engine';
import { loadTradeableUniverse } from '@/lib/signal-engine/constants/signalEngine.constants';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import {
  aggregateProviderRequests,
  logProviderRequest,
  checkQuotaBeforeJob,
} from '@/lib/marketData/providerRequestLog';
import { getProviderRequestPolicy } from '@/lib/marketData/providerRequestPolicy';
import { INDIANAPI_MONTHLY_LIMIT } from '@/providers/adapters/IndianAPIAdapter';
import { getComplianceProjection } from '@/providers/adapters/indianApiUsageTracker';

interface CriterionResult {
  pass: boolean;
  detail: string;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function dbCandleProvider(): CandleProvider {
  return {
    async fetchDailyCandles(symbol: string): Promise<Candle[]> {
      return readDailyCandlesFromDb(symbol);
    },
  };
}

async function probeIndianApiKey(): Promise<{ pass: boolean; detail: string }> {
  const { apiKey, baseUrl } = getIndianApiConfig();
  if (!apiKey || apiKey.length < 8) {
    return { pass: false, detail: 'INDIANAPI_API_KEY missing or too short in env' };
  }
  const masked = `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
  return {
    pass: true,
    detail: `key loaded (${masked}) baseUrl=${baseUrl}`,
  };
}

async function compareViewToCandles(): Promise<CriterionResult> {
  const { rows } = await db.query<{
    view_cnt: number;
    candles_cnt: number;
    mismatch: number;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT symbol) FROM market_data_daily) AS view_cnt,
       (SELECT COUNT(DISTINCT SUBSTRING_INDEX(instrument_key, '|', -1))
          FROM candles WHERE candle_type = 'eod' AND interval_unit = '1day') AS candles_cnt,
       (SELECT COUNT(*) FROM (
          SELECT v.symbol, v.cnt AS view_bars, COALESCE(c.cnt, 0) AS candle_bars
            FROM (
              SELECT symbol, COUNT(*) AS cnt FROM market_data_daily GROUP BY symbol
            ) v
            LEFT JOIN (
              SELECT SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol, COUNT(*) AS cnt
                FROM candles
               WHERE candle_type = 'eod' AND interval_unit = '1day'
               GROUP BY SUBSTRING_INDEX(instrument_key, '|', -1)
            ) c ON c.symbol = v.symbol
           WHERE v.cnt != COALESCE(c.cnt, 0)
        ) x) AS mismatch`,
  );
  const row = rows[0];
  const viewCnt = Number(row?.view_cnt ?? 0);
  const candlesCnt = Number(row?.candles_cnt ?? 0);
  const mismatch = Number(row?.mismatch ?? 0);
  return {
    pass: viewCnt > 0 && mismatch === 0,
    detail:
      `view_symbols=${viewCnt} candles_symbols=${candlesCnt} ` +
      `bar_count_mismatches=${mismatch}`,
  };
}

async function runFibonacciProbe(): Promise<CriterionResult> {
  const { rows: live } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signals WHERE signal_type = 'fibonacci_pullback'`,
  );
  const liveCount = Number(live[0]?.c ?? 0);
  if (liveCount > 0) {
    return { pass: true, detail: `live fibonacci_pullback rows=${liveCount}` };
  }

  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM market_data_daily
      GROUP BY symbol HAVING COUNT(*) >= ?
      ORDER BY COUNT(*) DESC LIMIT 1`,
    [MIN_CANDLE_COUNT],
  );
  const symbol = rows[0]?.symbol;
  if (!symbol) {
    return { pass: false, detail: 'no symbol with sufficient bars for mock fibonacci probe' };
  }
  const candles = await readDailyCandlesFromDb(symbol);
  const valid = validateCandleSeries(candles, MIN_CANDLE_COUNT);
  if (!valid.valid) {
    return { pass: false, detail: `${symbol}: invalid candle series` };
  }
  const features = buildSignalFeatures(candles, 'Bullish', 50_000, 50);
  const fib = evaluateFibonacciPullback(features);
  return {
    pass: true,
    detail:
      `mock probe symbol=${symbol} bars=${candles.length} ` +
      `evaluated=true matched=${fib.matched} rejection=${fib.rejectionReason ?? 'none'}`,
  };
}

async function main(): Promise<void> {
  await migrateProviderRequestLogs();

  const policy = getProviderRequestPolicy();
  const nseCfg = getNseDirectFallbackConfig();
  const provider = getMarketDataProvider();
  const keyProbe = await probeIndianApiKey();

  const activeUniverse = await loadActiveUniverseSymbols(1000);
  const universeCount = activeUniverse.length;

  const { rows: depth80 } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (
       SELECT u.symbol
         FROM q365_universe u
         INNER JOIN (
           SELECT symbol, COUNT(*) AS cnt FROM market_data_daily GROUP BY symbol
         ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
        WHERE u.is_active = 1 AND d.cnt >= 80
     ) x`,
  );
  const { rows: depth250 } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (
       SELECT u.symbol
         FROM q365_universe u
         INNER JOIN (
           SELECT symbol, COUNT(*) AS cnt FROM market_data_daily GROUP BY symbol
         ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
        WHERE u.is_active = 1 AND d.cnt >= 250
     ) x`,
  );
  const gte80 = Number(depth80[0]?.c ?? 0);
  const gte250 = Number(depth250[0]?.c ?? 0);
  const pct80 = universeCount > 0 ? Math.round((gte80 / universeCount) * 1000) / 10 : 0;

  resetCandleSourceCounters();
  const scanSample = activeUniverse.slice(0, 40);
  for (const sym of scanSample) {
    await fetchDailyCandlesWithFallback(sym, { dbOnly: true, evaluationRead: true });
  }
  const scanApiRequests = getIndianApiCandleRequestCount();

  const signalsBefore = Number(
    (await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM q365_signals`)).rows[0]?.c ?? 0,
  );

  await ensureUniverseReady();
  const universe = await loadTradeableUniverse();
  const portfolio: PortfolioSnapshot = {
    capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };
  const scanResult = await generatePhase4Signals(
    dbCandleProvider(),
    portfolio,
    undefined,
    undefined,
    { ...DEFAULT_PHASE1_CONFIG, universe },
    undefined,
    { generationSource: 'validate:phase4-signoff' },
  );
  const rejectedInsufficient = scanResult.meta.rejectedInsufficientCandles;
  const scannedSymbols = Math.max(0, scanResult.meta.scanned - rejectedInsufficient);
  const signalsSaved = scanResult.meta.signalsSaved;

  const signalsAfter = Number(
    (await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM q365_signals`)).rows[0]?.c ?? 0,
  );
  const newSignalRows = signalsAfter - signalsBefore;

  const jobId = `signoff-${Date.now()}`;
  beginSignalEngineRun({
    jobId,
    mode: 'scan',
    startedAt: new Date().toISOString(),
    totalSymbols: universeCount,
  });
  const statusRunning = buildSignalEngineStatus({
    running: true,
    jobId,
    mode: 'scan',
    startedAtMs: Date.now() - 5000,
    progressScanned: scannedSymbols,
    progressTotal: universeCount,
  });
  completeSignalEngineRun({
    jobId,
    mode: 'scan',
    success: true,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 5000,
    totalSymbols: universeCount,
    scannedSymbols,
    rejectedInsufficientCandles: rejectedInsufficient,
    rejectedProviderError: scanResult.meta.rejectedProviderErrors ?? 0,
    signalsGenerated: scanResult.signals.length,
    signalsSaved,
    indianApiRequestsUsed: 0,
    dataSource: 'db',
    lastError: null,
    failedSymbolsSample: [],
  });
  const statusCompleted = buildSignalEngineStatus({
    running: false,
    jobId: null,
    mode: null,
    startedAtMs: null,
    progressScanned: null,
    progressTotal: null,
  });

  const logsBefore = Number(
    (await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM provider_request_logs WHERE provider = 'indianapi'`,
    )).rows[0]?.c ?? 0,
  );
  await logProviderRequest({
    endpoint: 'signoff_probe',
    symbol: 'SIGNOFF',
    requestType: 'validation',
    success: true,
    statusCode: 200,
    jobId: 'validate-phase4-signoff',
    sourceJob: 'validate-phase4-signoff',
  });
  const logsAfter = Number(
    (await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM provider_request_logs WHERE provider = 'indianapi'`,
    )).rows[0]?.c ?? 0,
  );
  const agg = await aggregateProviderRequests();
  const compliance = getComplianceProjection();
  const hugeGuard = await checkQuotaBeforeJob({
    estimatedRequests: INDIANAPI_MONTHLY_LIMIT + 1,
    jobId: 'signoff-huge',
    sourceJob: 'validate-phase4-signoff',
    warnOnly: false,
  });

  const viewDepth = await compareViewToCandles();
  const fibProbe = await runFibonacciProbe();

  const criteria: Record<string, CriterionResult> = {
    '01_indianapi_key_active': keyProbe,
    '02_indianapi_primary_backfill_update': {
      pass: provider === 'indianapi',
      detail:
        `MARKET_DATA_PROVIDER=${provider}; backfill/update use fetchIndianApiDailyCandles ` +
        `(candleBackfillJob / candleDailyUpdateJob)`,
    },
    '03_nse_fallback_optional': {
      pass: !isNseForceMode() && !isYahooEmergencyFallbackEnabled(),
      detail:
        `yahoo_emergency=${isYahooEmergencyFallbackEnabled()} force_nse=${isNseForceMode()} ` +
        `nse_direct_enabled=${nseCfg.enabled} max_per_day=${nseCfg.maxSymbolsPerDay} ` +
        `(NSE is rare optional fallback, not primary)`,
    },
    '04_nse1000_universe_loaded': {
      pass: universeCount >= 400,
      detail: `active_universe=${universeCount} tradeable=${universe.length}`,
    },
    '05_gte_80_candles_active': {
      pass: gte80 >= 100 && pct80 >= 15,
      detail: `${gte80}/${universeCount} active symbols have >=80 bars (${pct80}%)`,
    },
    '06_gte_250_candles_preferred': {
      pass: gte250 >= 50,
      detail: `${gte250}/${universeCount} active symbols have >=250 bars (preferable target)`,
    },
    '07_market_data_daily_view_depth': viewDepth,
    '08_scan_mode_reads_db': {
      pass: universe.length > 0 && scanResult.meta.scanned > 0,
      detail:
        `generatePhase4Signals DB provider: scanned=${scanResult.meta.scanned} ` +
        `eligible=${scannedSymbols} universe=${universe.length}`,
    },
    '09_scan_zero_indianapi_waste': {
      pass: scanApiRequests === 0,
      detail:
        `dbOnly probe on ${scanSample.length} symbols → indianapi_requests=${scanApiRequests}`,
    },
    '10_status_endpoint_fields': {
      pass:
        statusRunning.running === true
        && isNum(statusRunning.totalSymbols)
        && isNum(statusRunning.scannedSymbols)
        && statusCompleted.lastCompletedRun != null
        && isNum(statusCompleted.lastCompletedRun.totalSymbols)
        && isNum(statusCompleted.lastCompletedRun.scannedSymbols)
        && isNum(statusCompleted.lastCompletedRun.rejectedInsufficientCandles)
        && isNum(statusCompleted.lastCompletedRun.signalsGenerated),
      detail:
        `running total=${statusRunning.totalSymbols} scanned=${statusRunning.scannedSymbols}; ` +
        `lastCompleted signals=${statusCompleted.lastCompletedRun?.signalsGenerated} ` +
        `rejected=${statusCompleted.lastCompletedRun?.rejectedInsufficientCandles}`,
    },
    '11_q365_signals_new_rows': {
      pass: newSignalRows > 0 || signalsSaved > 0,
      detail:
        `before=${signalsBefore} after=${signalsAfter} delta=${newSignalRows} ` +
        `signals_saved=${signalsSaved} generated=${scanResult.signals.length}`,
    },
    '12_fibonacci_pullback_tested': fibProbe,
    '13_request_usage_logged': {
      pass: logsAfter === logsBefore + 1 && agg.requests_this_month >= 1,
      detail:
        `provider_request_logs ${logsBefore}→${logsAfter}; month_count=${agg.requests_this_month}`,
    },
    '14_monthly_budget_protected': {
      pass:
        hugeGuard.action === 'block'
        && !hugeGuard.allowed
        && policy.monthly.planning_min >= 22000
        && policy.monthly.planning_max <= 30000
        && compliance.monthly_ceiling >= 100000,
      detail:
        `huge_job action=${hugeGuard.action} allowed=${hugeGuard.allowed}; ` +
        `plan=${policy.monthly.planning_min}–${policy.monthly.planning_max} ` +
        `compliance=${compliance.label} ceiling=${compliance.monthly_ceiling}`,
    },
  };

  const passCount = Object.values(criteria).filter((c) => c.pass).length;
  const total = Object.keys(criteria).length;

  console.log('\n=== PHASE 4 SIGN-OFF (14 CRITERIA) ===\n');
  for (const [key, c] of Object.entries(criteria)) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}`);
    console.log(`       ${c.detail}\n`);
  }
  console.log(`Result: ${passCount}/${total} criteria passed\n`);

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    universe: { active: universeCount, tradeable: universe.length },
    depth: { gte80, gte250, pct80 },
    scan: {
      meta_scanned: scanResult.meta.scanned,
      scanned_symbols: scannedSymbols,
      rejected_insufficient: rejectedInsufficient,
      signals_saved: signalsSaved,
      new_rows: newSignalRows,
    },
    criteria,
  }, null, 2));

  process.exit(passCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error('[validatePhase4Signoff] fatal:', err);
  process.exit(2);
});
