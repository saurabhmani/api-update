/**
 * seedFibonacciPullbackTest.ts
 *
 * Seeds controlled market_data_daily bars + runs Phase 4 on a test symbol
 * to verify fibonacci_pullback strategy wiring end-to-end.
 *
 * Usage:
 *   npx tsx scripts/seedFibonacciPullbackTest.ts --apply --run
 *   npx tsx scripts/seedFibonacciPullbackTest.ts --cleanup
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env.production') });

import { db } from '@/lib/db';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { evaluateFibonacciPullback } from '@/lib/signal-engine/strategies/fibonacciPullback';
import { validateCandleSeries } from '@/lib/signal-engine/utils/candles';
import {
  MIN_CANDLE_COUNT,
  STRUCTURE_LOOKBACK,
  DEFAULT_PHASE1_CONFIG,
} from '@/lib/signal-engine/constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG } from '@/lib/signal-engine/constants/phase3.constants';
import { generatePhase4Signals } from '@/lib/signal-engine';
import type { CandleProvider, PortfolioSnapshot } from '@/lib/signal-engine';
import { calculateFibonacciLevels } from '@/lib/signal-engine/indicators/fibonacci';
import { persistBarsForSymbol } from '@/lib/marketData/candleBackfillJob';

const TEST_SYMBOL = 'FIBPROBE';
const BENCH_SYMBOL = 'FIBBENCH';
const BAR_COUNT = 260;
const MIN_VOLUME = 200_000;

const APPLY = process.argv.includes('--apply');
const RUN = process.argv.includes('--run');
const CLEANUP = process.argv.includes('--cleanup');

function tradingDaysBack(count: number): string[] {
  const out: string[] = [];
  // End on the previous calendar day so the last bar is never "today"
  // (Phase 1 data-quality treats same-day last candles as incomplete).
  const cursor = new Date();
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (out.length < count) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.unshift(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

function makeBar(ts: string, o: number, h: number, l: number, c: number, v = MIN_VOLUME): Candle {
  return { ts, open: o, high: h, low: l, close: c, volume: v };
}

/**
 * Craft a bullish series whose last bar sits on the 50% Fib retracement
 * of the prior STRUCTURE_LOOKBACK swing range, with EMA20 > EMA50.
 */
export function buildFibonacciTestCandles(): Candle[] {
  const dates = tradingDaysBack(BAR_COUNT);
  const swingHigh = 220;
  const swingLow = 160;
  const targetClose = calculateFibonacciLevels(swingHigh, swingLow).fib50!;

  const candles: Candle[] = [];
  for (let i = 0; i < dates.length; i++) {
    const close = 100 + (i / (dates.length - 1)) * 95;
    const open = i === 0 ? close : candles[i - 1].close;
    candles.push(makeBar(dates[i], open, close + 1.5, close - 1, close));
  }

  const n = candles.length;
  const lookStart = n - STRUCTURE_LOOKBACK - 1;

  // Pin swing extremes inside lookback (exclude final bar)
  const highIdx = lookStart + 4;
  const lowIdx = lookStart + 14;
  candles[highIdx].high = swingHigh;
  candles[highIdx].close = swingHigh - 0.5;
  candles[lowIdx].low = swingLow;
  candles[lowIdx].close = swingLow + 0.5;

  // Mild pullback into golden zone on final bars without inverting EMA stack
  for (let j = n - 8; j < n - 1; j++) {
    const t = (j - (n - 8)) / 6;
    const close = targetClose + 6 * (1 - t);
    candles[j].close = close;
    candles[j].open = close - 0.3;
    candles[j].high = close + 1;
    candles[j].low = close - 1;
  }

  const last = candles[n - 1];
  last.close = targetClose;
  last.open = targetClose - 0.2;
  last.high = targetClose + 0.8;
  last.low = targetClose - 0.8;

  return candles;
}

function tuneUntilFibMatch(candles: Candle[]): Candle[] {
  const base = candles.map((c) => ({ ...c }));
  const n = base.length;
  const lookStart = n - STRUCTURE_LOOKBACK - 1;
  const hi = Math.max(...base.slice(lookStart, n - 1).map((c) => c.high));
  const lo = Math.min(...base.slice(lookStart, n - 1).map((c) => c.low));
  const levels = calculateFibonacciLevels(hi, lo);
  const targets = [levels.fib382, levels.fib50, levels.fib618].filter(
    (v): v is number => v != null && Number.isFinite(v),
  );

  for (const target of targets) {
    for (let drift = -2; drift <= 2; drift += 0.25) {
      const out = base.map((c) => ({ ...c }));
      const close = target + drift;
      // Soft pullback last 12 bars — cools RSI while keeping EMA stack
      for (let j = n - 12; j < n - 1; j++) {
        const t = (j - (n - 12)) / 11;
        const c = close + (out[j].close - close) * (1 - t) * 0.35;
        out[j].close = c;
        out[j].open = c - 0.2;
        out[j].high = c + 0.8;
        out[j].low = c - 0.8;
      }
      const last = out[n - 1];
      last.close = close;
      last.open = close - 0.15;
      last.high = close + 0.6;
      last.low = close - 0.6;

      const probe = probeStrategy(out, 'Bullish');
      if (probe.result.matched) return out;
    }
  }
  return base;
}

/** Strong bullish benchmark series so regime classifies as Bullish. */
export function buildBullishBenchmarkCandles(): Candle[] {
  const dates = tradingDaysBack(BAR_COUNT);
  const candles: Candle[] = [];
  for (let i = 0; i < dates.length; i++) {
    const close = 200 + i * 0.35;
    const open = i === 0 ? close : candles[i - 1].close;
    candles.push(makeBar(dates[i], open, close + 1.2, close - 0.8, close));
  }
  return candles;
}

async function upsertCandles(symbol: string, candles: Candle[]): Promise<number> {
  if (candles.length === 0) return 0;
  const bars = candles.map((c) => ({
    ts: c.ts,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? MIN_VOLUME,
  }));
  await persistBarsForSymbol(symbol, bars);
  return bars.length;
}

async function deleteCandles(symbol: string): Promise<void> {
  await db.query(`DELETE FROM candles WHERE instrument_key = ?`, [`NSE_EQ|${symbol}`]);
}

async function ensureUniverseSymbol(symbol: string, name: string, isin: string): Promise<void> {
  await db.query(
    `INSERT INTO q365_universe (symbol, company_name, isin, sector, is_active)
     VALUES (?, ?, ?, 'TEST', 1)
     ON DUPLICATE KEY UPDATE is_active = 1, company_name = VALUES(company_name)`,
    [symbol, name, isin],
  );
}

async function cleanupTestData(): Promise<void> {
  await db.query(`DELETE FROM q365_signals WHERE symbol = ?`, [TEST_SYMBOL]);
  await db.query(`DELETE FROM q365_signal_maturity_tracker WHERE symbol = ?`, [TEST_SYMBOL]);
  await deleteCandles(TEST_SYMBOL);
  await deleteCandles(BENCH_SYMBOL);
  await db.query(
    `DELETE FROM q365_universe WHERE symbol IN (?, ?)`,
    [TEST_SYMBOL, BENCH_SYMBOL],
  );
  console.log(`Cleaned signals, tracker, candles, and universe rows for ${TEST_SYMBOL} / ${BENCH_SYMBOL}`);
}

function probeStrategy(candles: Candle[], regime: 'Bullish' | 'Strong Bullish' = 'Bullish') {
  const valid = validateCandleSeries(candles, MIN_CANDLE_COUNT);
  const features = buildSignalFeatures(candles, regime, 50_000, 10);
  const result = evaluateFibonacciPullback(features);
  return { valid, features, result };
}

async function runPhase4OnTestSymbol(benchHasDedicatedSeries: boolean): Promise<void> {
  const provider: CandleProvider = {
    async fetchDailyCandles(symbol: string): Promise<Candle[]> {
      const sym = symbol.toUpperCase();
      const target = sym === TEST_SYMBOL
        ? TEST_SYMBOL
        : (sym === BENCH_SYMBOL || sym === DEFAULT_PHASE1_CONFIG.benchmarkSymbol
          ? BENCH_SYMBOL
          : sym);
      const { rows } = await db.query<any>(
        `SELECT ts, open, high, low, close, volume
           FROM market_data_daily
          WHERE symbol = ?
          ORDER BY ts ASC`,
        [target],
      );
      return (rows as any[]).map((r) => ({
        ts:     r.ts instanceof Date ? r.ts.toISOString().slice(0, 10) : String(r.ts).slice(0, 10),
        open:   Number(r.open),
        high:   Number(r.high),
        low:    Number(r.low),
        close:  Number(r.close),
        volume: Number(r.volume ?? 0),
      }));
    },
  };

  const portfolio: PortfolioSnapshot = {
    capital:        DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable:  DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions:  [],
    pendingSignals: [],
  };

  const phase1Config = {
    ...DEFAULT_PHASE1_CONFIG,
    universe: [TEST_SYMBOL],
    benchmarkSymbol: BENCH_SYMBOL,
    minAvgVolume: 50_000,
    minPrice: 10,
  };

  console.log(`Running Phase 4 on universe=[${TEST_SYMBOL}] benchmark=${BENCH_SYMBOL}...`);
  const result = await generatePhase4Signals(
    provider,
    portfolio,
    undefined,
    undefined,
    phase1Config,
    undefined,
    { generationSource: 'scripts:fibonacci-pullback-test' },
  );

  const fibSignals = result.signals.filter((s) => s.signalType === 'fibonacci_pullback');
  console.log('\nPhase 4 result:', {
    scanned: result.meta.scanned,
    signals: result.signals.length,
    fibonacci_candidates: fibSignals.length,
    saved: result.meta.signalsSaved,
    regime: result.meta.regime,
  });

  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signals
      WHERE symbol = ? AND signal_type = 'fibonacci_pullback'`,
    [TEST_SYMBOL],
  );
  const dbCount = Number(rows[0]?.c ?? 0);
  console.log(`DB rows for ${TEST_SYMBOL} fibonacci_pullback: ${dbCount}`);

  if (dbCount === 0 && fibSignals.length === 0) {
    const { rows: rejects } = await db.query<{ message: string }>(
      `SELECT message FROM q365_signal_reasons r
         JOIN q365_signals s ON s.id = r.signal_id
        WHERE s.symbol = ?
        ORDER BY r.id DESC LIMIT 5`,
      [TEST_SYMBOL],
    );
    console.log('Recent rejection reasons:', rejects);
    process.exit(1);
  }

  const { rows: saved } = await db.query(
    `SELECT id, symbol, signal_type, direction, confidence_score, created_at
       FROM q365_signals
      WHERE symbol = ? AND signal_type = 'fibonacci_pullback'
      ORDER BY created_at DESC LIMIT 5`,
    [TEST_SYMBOL],
  );
  console.log('\nSaved fibonacci_pullback rows:', saved);
  process.exit(0);
}

async function main(): Promise<void> {
  if (CLEANUP) {
    await cleanupTestData();
    process.exit(0);
  }

  let testCandles = tuneUntilFibMatch(buildFibonacciTestCandles());
  const benchCandles = buildBullishBenchmarkCandles();

  let probe = probeStrategy(testCandles, 'Bullish');
  console.log('\n=== FIBONACCI PULLBACK CONTROLLED TEST ===\n');
  console.log('Pre-flight strategy probe (Bullish regime):', {
    candles: testCandles.length,
    valid: probe.valid.valid,
    matched: probe.result.matched,
    rejection: probe.result.rejectionReason ?? null,
    fibZoneMatched: probe.features.structure.fibZoneMatched,
    rsi: probe.features.momentum.rsi14,
    ema20Above50: probe.features.trend.ema20Above50,
    closeAbove200: probe.features.trend.closeAbove200Ema,
  });

  if (!probe.result.matched) {
    console.error('Could not craft candles that match fibonacci_pullback — aborting.');
    process.exit(2);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to upsert DB rows, --run to execute Phase 4.');
    process.exit(0);
  }

  await ensureUniverseSymbol(TEST_SYMBOL, 'Fibonacci Test Probe', 'TESTFIB001');
  await ensureUniverseSymbol(BENCH_SYMBOL, 'Fibonacci Test Benchmark', 'TESTFIB002');
  await deleteCandles(TEST_SYMBOL);
  await deleteCandles(BENCH_SYMBOL);
  const nTest = await upsertCandles(TEST_SYMBOL, testCandles);
  const nBench = await upsertCandles(BENCH_SYMBOL, benchCandles);
  console.log(`\nUpserted ${nTest} bars for ${TEST_SYMBOL}, ${nBench} bars for ${BENCH_SYMBOL}`);

  const { rows: depth } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM market_data_daily WHERE symbol = ?`,
    [TEST_SYMBOL],
  );
  console.log(`${TEST_SYMBOL} bar count in DB: ${depth[0]?.c}`);

  if (!RUN) {
    console.log('\nDB seeded. Re-run with --apply --run to execute Phase 4 and verify persistence.');
    process.exit(0);
  }

  await runPhase4OnTestSymbol(true);
}

const isDirectRun = process.argv[1]?.includes('seedFibonacciPullbackTest');
if (isDirectRun) {
  main().catch((err) => {
    console.error('[seedFibonacciPullbackTest] fatal:', err);
    process.exit(2);
  });
}
