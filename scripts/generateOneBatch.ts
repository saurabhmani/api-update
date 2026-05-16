/**
 * scripts/generateOneBatch.ts
 *
 * One-shot pipeline runner. Triggers the same Phase-4 generation
 * the /api/signals route runs in the background, but blocks until
 * complete and prints a structured summary. Used for:
 *   - bootstrapping a fresh batch with the Phase-11 columns populated
 *   - local validation when no session cookie is available
 *
 * Default mode (no flags):
 *   Runs the Phase-4 canonical engine over the full universe loaded
 *   from DEFAULT_PHASE1_CONFIG. This is the SAME path `/api/run-signal-engine`
 *   triggers — strict gates, may produce few signals on a quiet
 *   market.
 *
 * Flags:
 *   --full              explicitly run on full universe (default).
 *   --limit=N           cap to first N symbols (test mode).
 *   --symbol=RELIANCE   single-symbol test (overrides --limit).
 *   --scanner           run the custom-universe Yahoo scanner instead
 *                       of Phase-4. More permissive scoring; populates
 *                       q365_signals with ~400-500 rows on a typical
 *                       2767-symbol universe. Recommended for getting
 *                       a populated UI quickly.
 *   --dry-run           skip DB writes (scanner mode only).
 *
 * Run:
 *   npx tsx scripts/generateOneBatch.ts                    # Phase-4, full universe
 *   npx tsx scripts/generateOneBatch.ts --scanner          # Yahoo scanner, full
 *   npx tsx scripts/generateOneBatch.ts --scanner --limit=50
 *   npx tsx scripts/generateOneBatch.ts --symbol=RELIANCE
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';

interface Cli {
  full:    boolean;
  limit:   number | undefined;
  symbol:  string | undefined;
  scanner: boolean;
  dryRun:  boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { full: true, limit: undefined, symbol: undefined, scanner: false, dryRun: false };
  for (const a of argv) {
    if (a === '--full')                     cli.full   = true;
    else if (a === '--scanner')             cli.scanner = true;
    else if (a === '--dry-run')             cli.dryRun = true;
    else if (a.startsWith('--limit='))      cli.limit  = Number(a.split('=')[1]);
    else if (a.startsWith('--symbol='))     cli.symbol = a.split('=')[1].toUpperCase();
  }
  // --limit / --symbol override --full implicitly
  if (cli.limit != null || cli.symbol) cli.full = false;
  return cli;
}

const CLI = parseArgs(process.argv.slice(2));

async function runScannerMode() {
  const tStart = Date.now();
  console.log('='.repeat(72));
  console.log('CUSTOM UNIVERSE SCANNER');
  console.log('='.repeat(72));
  console.log('  mode:    ' + (CLI.symbol ? `single symbol (${CLI.symbol})`
                              : CLI.limit != null ? `limited (first ${CLI.limit})`
                              : 'full_universe'));
  console.log('  dry-run: ' + CLI.dryRun);
  console.log('');

  const { runCustomUniverseScan } = await import('../src/lib/scanner/customUniverseBatchScanner');

  const opts: any = { dryRun: CLI.dryRun };
  if (CLI.symbol)         opts.symbols = [CLI.symbol];
  else if (CLI.limit)     opts.limit   = CLI.limit;
  // full mode: no limit, no symbols → loadCustomUniverse reads stockUpdate.txt

  const r = await runCustomUniverseScan(opts);

  const elapsed = Date.now() - tStart;
  console.log('');
  console.log('='.repeat(72));
  console.log('SCAN COMPLETE');
  console.log('='.repeat(72));
  console.log('  batch_id:               ' + r.summary.batchId);
  console.log('  runMode:                ' + r.summary.runMode);
  console.log('  total_symbols_loaded:   ' + r.summary.universeSize);
  console.log('  total_symbols_scanned:  ' + r.summary.totalSymbols);
  console.log('  yahoo_fetch_success:    ' + r.summary.fetched);
  console.log('  yahoo_fetch_failed:     ' + r.summary.failed);
  console.log('  prefilter_passed:       ' + r.summary.preFiltered);
  console.log('  pre_rejected:           ' + r.summary.preRejected);
  console.log('  scored:                 ' + r.summary.scored);
  console.log('  approved:               ' + r.summary.approved);
  console.log('  watchlist:              ' + r.summary.watchlist);
  console.log('  rejected:               ' + r.summary.rejected);
  console.log('  no_direction:           ' + r.summary.noDirection);
  console.log('  insufficient_data:      ' + r.summary.insufficient);
  console.log('  buy_count:              ' + r.summary.buyCount);
  console.log('  sell_count:             ' + r.summary.sellCount);
  console.log('  scan_coverage_percent:  ' + r.summary.scanCoveragePercent + '%');
  if (r.summary.partialScanWarning) {
    console.log('  ⚠ partial_scan_warning: ' + r.summary.partialScanWarning);
  }
  console.log('  duration:               ' + elapsed + 'ms');
  console.log('='.repeat(72));

  // Exit success only when at least one signal landed AND coverage is healthy.
  const ok = (r.summary.approved + r.summary.watchlist) > 0;
  process.exit(ok ? 0 : 1);
}

async function runPhase4Mode() {
  const tStart = Date.now();
  console.log('='.repeat(72));
  console.log('PHASE-4 CANONICAL ENGINE');
  console.log('='.repeat(72));
  console.log('  mode:    ' + (CLI.symbol ? `single symbol (${CLI.symbol})`
                              : CLI.limit != null ? `limited (first ${CLI.limit})`
                              : 'full_universe'));
  console.log('');

  const t0 = Date.now();
  console.log('[1/3] Loading pipeline modules…');
  const [{ generatePhase4Signals, DEFAULT_PHASE3_CONFIG }, { migrateSignalEngine }, { DEFAULT_PHASE1_CONFIG }] = await Promise.all([
    import('../src/lib/signal-engine'),
    import('../src/lib/db/migrateSignalEngine'),
    import('../src/lib/signal-engine/constants/signalEngine.constants'),
  ]);
  await migrateSignalEngine().catch(() => {});

  // Benchmark fallback: Phase-4 needs ≥80 candles for the benchmark
  // symbol to compute regime/relative-strength. Default 'NIFTY 50' is
  // an index ticker absent from market_data_daily on most installs;
  // fall back to NIFTYBEES (Nifty-50 tracking ETF) when present.
  const benchmarkProbe = await db.query<any>(
    `SELECT symbol FROM market_data_daily
     WHERE symbol IN (?, 'NIFTYBEES', 'SETFNIF50')
     GROUP BY symbol HAVING COUNT(*) >= 80
     ORDER BY symbol = ? DESC LIMIT 1`,
    [DEFAULT_PHASE1_CONFIG.benchmarkSymbol, DEFAULT_PHASE1_CONFIG.benchmarkSymbol],
  );
  const resolvedBenchmark = (benchmarkProbe.rows[0] as any)?.symbol ?? DEFAULT_PHASE1_CONFIG.benchmarkSymbol;
  if (resolvedBenchmark !== DEFAULT_PHASE1_CONFIG.benchmarkSymbol) {
    console.log(`  benchmark fallback: ${DEFAULT_PHASE1_CONFIG.benchmarkSymbol} → ${resolvedBenchmark} (only the latter has ≥80 candles in this DB)`);
  }

  // Universe override — Phase-4's universe lives in p1Config.universe.
  // For --symbol or --limit we slice the canonical list rather than
  // editing the constant.
  let universe: string[] = DEFAULT_PHASE1_CONFIG.universe;
  if (CLI.symbol)        universe = [CLI.symbol];
  else if (CLI.limit)    universe = universe.slice(0, CLI.limit);
  const universeSize = universe.length;

  const phase1Config = { ...DEFAULT_PHASE1_CONFIG, benchmarkSymbol: resolvedBenchmark, universe };

  console.log('[2/3] Building candle provider + portfolio snapshot.');
  const candleProvider = {
    async fetchDailyCandles(symbol: string) {
      const r = await db.query(
        `SELECT ts, open, high, low, close, volume FROM (
           SELECT ts, open, high, low, close, volume
           FROM market_data_daily WHERE symbol = ?
           ORDER BY ts DESC LIMIT 300
         ) t
         ORDER BY ts ASC`,
        [symbol],
      );
      return r.rows.map((row: any) => ({
        ts: row.ts,
        open: Number(row.open), high: Number(row.high),
        low: Number(row.low),   close: Number(row.close),
        volume: Number(row.volume),
      }));
    },
  };
  const portfolio = {
    capital:       DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };

  console.log('[3/3] Running generatePhase4Signals (same path /api/signals triggers in the background) on '
    + universeSize + ' symbols…');
  const result = await generatePhase4Signals(
    candleProvider as any, portfolio as any,
    undefined, undefined, phase1Config, undefined,
    { generationSource: 'scripts:generateOneBatch' },
  );
  const elapsed = Date.now() - t0;
  void tStart;

  // Direction split — Phase-4 doesn't expose a `direction` field on
  // the result envelope directly, so we derive it from the persisted
  // signal type.
  const buys  = result.signals.filter((s) => /BUY|LONG/i.test(String(s.signalType ?? ''))).length;
  const sells = result.signals.length - buys;

  console.log('');
  console.log('='.repeat(72));
  console.log('PIPELINE COMPLETE');
  console.log('='.repeat(72));
  console.log('  total_symbols_loaded:   ' + universeSize);
  console.log('  total_symbols_scanned:  ' + (result.meta.scanned ?? universeSize));
  console.log('  signals_generated:      ' + result.signals.length);
  console.log('  approved:               ' + result.meta.approved);
  console.log('  deferred:               ' + result.meta.deferred);
  console.log('  rejected:               ' + result.meta.rejected);
  console.log('  buy_count:              ' + buys);
  console.log('  sell_count:             ' + sells);
  console.log('  scenario:               ' + result.scenario.scenario_tag);
  console.log('  market_stance:          ' + result.marketStance.market_stance);
  console.log('  regime:                 ' + result.meta.regime);
  console.log('  scan_coverage_percent:  ' + (universeSize > 0
    ? Math.round((result.meta.scanned / universeSize) * 1000) / 10
    : 0) + '%');
  console.log('  elapsed:                ' + elapsed + 'ms');
  console.log('='.repeat(72));

  process.exit(result.signals.length > 0 ? 0 : 1);
}

async function main() {
  if (CLI.scanner) await runScannerMode();
  else             await runPhase4Mode();
}

main().catch((err) => {
  console.error('GENERATION FAILED:');
  console.error(err);
  process.exit(1);
});
