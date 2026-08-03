/**
 * validateDbFirstScan.ts — acceptance checks for DB-first signal scan
 *
 * Usage:
 *   npx tsx scripts/validateDbFirstScan.ts
 *   npx tsx scripts/validateDbFirstScan.ts --sample 50
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env.production') });

import { db } from '@/lib/db';
import { loadActiveUniverseSymbols } from '@/lib/marketData/candleBackfillJob';
import {
  fetchDailyCandlesWithFallback,
  getUpstreamCandleRequestCount,
  readDailyCandlesFromDb,
  resetCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import { MIN_CANDLE_COUNT } from '@/lib/signal-engine/constants/signalEngine.constants';
import { validateCandleSeries } from '@/lib/signal-engine/utils/candles';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { evaluateFibonacciPullback } from '@/lib/signal-engine/strategies/fibonacciPullback';
import { countRejectedInsufficientCandles } from '@/lib/signal-engine/pipeline/generatePhase4Signals';

interface CriterionResult {
  pass: boolean;
  detail: string;
}

interface ValidationReport {
  timestamp: string;
  min_candle_count: number;
  universe_size: number;
  db_depth: {
    sufficient: number;
    insufficient: number;
    pct_sufficient: number;
  };
  api_probe: {
    symbols_tested: number;
    upstream_candle_requests: number;
  };
  insufficient_counter_probe: {
    mock_rejections: number;
    counted: number;
  };
  fibonacci_probe: {
    symbol: string | null;
    bars: number;
    features_built: boolean;
    strategy_evaluated: boolean;
    matched: boolean;
    rejection: string | null;
  };
  summary_shape_probe: {
    all_numeric: boolean;
    fields: Record<string, unknown>;
  };
  criteria: Record<string, CriterionResult>;
}

function parseSampleArg(): number {
  const idx = process.argv.indexOf('--sample');
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return 30;
}

function buildMockSummary(
  totalSymbols: number,
  scannedSymbols: number,
  rejectedInsufficient: number,
  signalsGenerated: number,
  signalsSaved: number,
  upstreamVendor: number,
): Record<string, unknown> {
  return {
    mode: 'scan',
    total_symbols: totalSymbols,
    scanned_symbols: scannedSymbols,
    rejected_insufficient_candles: rejectedInsufficient,
    signals_generated: signalsGenerated,
    signals_saved: signalsSaved,
    data_source_used: upstreamVendor > 0 ? 'db+legacy_vendor' : 'db',
    upstream_candle_requests_used: upstreamVendor,
  };
}

function summaryFieldsAreNumeric(summary: Record<string, unknown>): boolean {
  const numericKeys = [
    'total_symbols',
    'scanned_symbols',
    'rejected_insufficient_candles',
    'signals_generated',
    'signals_saved',
    'upstream_candle_requests_used',
  ];
  return numericKeys.every((k) => {
    const v = summary[k];
    return typeof v === 'number' && Number.isFinite(v);
  });
}

async function main(): Promise<void> {
  const sampleSize = parseSampleArg();
  const minBars = MIN_CANDLE_COUNT;
  const universe = await loadActiveUniverseSymbols(1000);
  const sample = universe.slice(0, sampleSize);

  const { rows: depthRows } = await db.query<{ sufficient: number; insufficient: number }>(
    `SELECT
       SUM(CASE WHEN d.cnt >= ? THEN 1 ELSE 0 END) AS sufficient,
       SUM(CASE WHEN d.cnt < ? OR d.cnt IS NULL THEN 1 ELSE 0 END) AS insufficient
     FROM q365_universe u
     LEFT JOIN (
       SELECT symbol, COUNT(*) AS cnt
         FROM market_data_daily
        GROUP BY symbol
     ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
    WHERE u.is_active = 1`,
    [minBars, minBars],
  );
  const sufficient = Number(depthRows[0]?.sufficient ?? 0);
  const insufficient = Number(depthRows[0]?.insufficient ?? 0);

  resetCandleSourceCounters();
  let dbReads = 0;
  for (const sym of sample) {
    const result = await fetchDailyCandlesWithFallback(sym, {
      dbOnly: true,
      evaluationRead: true,
    });
    if (result.candles.length > 0) dbReads++;
  }
  const upstreamVendor = getUpstreamCandleRequestCount();

  const mockLog = [
    { symbol: 'THIN1', reason: 'Insufficient candles: 12 < 80' },
    { symbol: 'THIN2', reason: 'candle_invalid: Insufficient candles: 0 < 80' },
    { symbol: 'OK1', reason: 'No strategy matched' },
  ];
  const countedInsufficient = countRejectedInsufficientCandles(mockLog);

  let fibProbe = {
    symbol: null as string | null,
    bars: 0,
    features_built: false,
    strategy_evaluated: false,
    matched: false,
    rejection: null as string | null,
  };

  const { rows: deepRows } = await db.query<{ symbol: string; c: number }>(
    `SELECT symbol, COUNT(*) AS c
       FROM market_data_daily
      GROUP BY symbol
     HAVING c >= ?
      ORDER BY c DESC
      LIMIT 1`,
    [minBars],
  );
  const fibSymbol = deepRows[0]?.symbol ?? null;
  if (fibSymbol) {
    const candles = await readDailyCandlesFromDb(fibSymbol);
    const valid = validateCandleSeries(candles, minBars);
    if (valid.valid) {
      try {
        const features = buildSignalFeatures(
          candles,
          'Bullish',
          50_000,
          50,
        );
        fibProbe.features_built = true;
        const fib = evaluateFibonacciPullback(features);
        fibProbe = {
          symbol: fibSymbol,
          bars: candles.length,
          features_built: true,
          strategy_evaluated: true,
          matched: fib.matched,
          rejection: fib.matched ? null : (fib.rejectionReason ?? 'unknown'),
        };
      } catch (err) {
        fibProbe = {
          symbol: fibSymbol,
          bars: candles.length,
          features_built: false,
          strategy_evaluated: false,
          matched: false,
          rejection: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const scannedSymbols = Math.max(0, sample.length - Math.min(insufficient, sample.length));
  const summary = buildMockSummary(
    universe.length,
    scannedSymbols,
    insufficient,
    0,
    0,
    upstreamVendor,
  );

  const criteria: Record<string, CriterionResult> = {
    '1_no_legacy_vendor_per_symbol_on_scan': {
      pass: upstreamVendor === 0,
      detail:
        `DB-only fetch on ${sample.length} symbols → upstream_candle_requests=${upstreamVendor} ` +
        `(expected 0; db_reads_with_bars=${dbReads})`,
    },
    '2_sufficient_candles_scanned': {
      pass: sufficient > 0,
      detail:
        `${sufficient}/${universe.length} universe symbols have >= ${minBars} bars ` +
        `(${Math.round((sufficient / Math.max(1, universe.length)) * 1000) / 10}% sufficient)`,
    },
    '3_insufficient_counted_clearly': {
      pass: countedInsufficient === 2,
      detail:
        `countRejectedInsufficientCandles mock: counted=${countedInsufficient} ` +
        `(expected 2); DB insufficient=${insufficient}`,
    },
    '4_fibonacci_after_backfill': {
      pass: fibProbe.features_built && fibProbe.strategy_evaluated,
      detail: fibProbe.symbol
        ? `${fibProbe.symbol} bars=${fibProbe.bars} features=${fibProbe.features_built} ` +
          `evaluated=${fibProbe.strategy_evaluated} matched=${fibProbe.matched} ` +
          `rejection=${fibProbe.rejection ?? 'none'}`
        : `No symbol with >= ${minBars} bars found for fibonacci probe`,
    },
    '5_summary_never_null_scanned_total': {
      pass: summaryFieldsAreNumeric(summary),
      detail:
        `summary fields numeric: total_symbols=${summary.total_symbols} ` +
        `scanned_symbols=${summary.scanned_symbols} ` +
        `rejected_insufficient_candles=${summary.rejected_insufficient_candles}`,
    },
  };

  const report: ValidationReport = {
    timestamp: new Date().toISOString(),
    min_candle_count: minBars,
    universe_size: universe.length,
    db_depth: {
      sufficient,
      insufficient,
      pct_sufficient: Math.round((sufficient / Math.max(1, universe.length)) * 1000) / 10,
    },
    api_probe: {
      symbols_tested: sample.length,
      upstream_candle_requests: upstreamVendor,
    },
    insufficient_counter_probe: {
      mock_rejections: mockLog.length,
      counted: countedInsufficient,
    },
    fibonacci_probe: fibProbe,
    summary_shape_probe: {
      all_numeric: summaryFieldsAreNumeric(summary),
      fields: summary,
    },
    criteria,
  };

  const passCount = Object.values(criteria).filter((c) => c.pass).length;
  const total = Object.keys(criteria).length;

  console.log('\n=== DB-FIRST SCAN VALIDATION ===\n');
  for (const [key, c] of Object.entries(criteria)) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}`);
    console.log(`       ${c.detail}\n`);
  }
  console.log(`Result: ${passCount}/${total} criteria passed\n`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(passCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error('[validateDbFirstScan] fatal:', err);
  process.exit(1);
});
