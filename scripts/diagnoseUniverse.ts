/**
 * scripts/diagnoseUniverse.ts
 *
 * Spec INSTITUTIONAL §C — universe-loading + candle-availability audit.
 *
 * Walks every input the scanner depends on and reports a one-page
 * diagnostic table. Exits 0 if the universe loads to >= 480 symbols
 * AND the candle table has rows; exits 1 otherwise with a
 * stage-by-stage failure breakdown.
 *
 * Prints, per spec:
 *   { universe_path, file_exists, parsed_symbols, valid_symbols,
 *     final_universe_size }
 *
 * Plus the candle availability probe:
 *   SELECT COUNT(*) FROM market_data_daily;
 *   SELECT MAX(ts), MIN(ts), COUNT(DISTINCT symbol) FROM market_data_daily;
 *
 * And the structured markers the operator can grep:
 *   [UNIVERSE_LOAD] / [UNIVERSE_PARSE] / [UNIVERSE_FINAL] / [CANDLE_DB_COUNT]
 *
 * Usage:
 *   npx tsx scripts/diagnoseUniverse.ts
 *   npx tsx scripts/diagnoseUniverse.ts --csv path/to/list.csv
 *   npx tsx scripts/diagnoseUniverse.ts --no-init    # skip the live initOnce()
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { db } from '../src/lib/db';
import {
  initOnce,
  isNifty500Initialized,
  NIFTY500_MIN_SIZE,
  NIFTY500_MAX_SIZE,
  _resetNifty500CacheForTests,
} from '../src/lib/marketData/nifty500Universe';
import { DEFAULT_PHASE1_CONFIG } from '../src/lib/signal-engine/constants/signalEngine.constants';

interface Args {
  csv:    string;
  noInit: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 ? (argv[i + 1] ?? d) : d;
  };
  const csv = process.env.UNIVERSE_SEED_CSV_PATH
    ?? get('--csv', 'ind_nifty500list.csv');
  const noInit = argv.includes('--no-init');
  return { csv: resolvePath(process.cwd(), csv), noInit };
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch; continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); out.push(row); }
  return out;
}

function parseCsvSymbols(path: string): { parsed: number; valid: number; sample: string[] } {
  if (!existsSync(path)) return { parsed: 0, valid: 0, sample: [] };
  const raw = readFileSync(path, 'utf8');
  const grid = parseCsv(raw).filter((r) => r.length > 1 && r.some((c) => c.trim() !== ''));
  if (grid.length === 0) return { parsed: 0, valid: 0, sample: [] };
  const headers = grid[0];
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const wanted = ['symbol', 'trading symbol'];
  const iSymbol = headers.findIndex((h) => wanted.includes(norm(h)));
  if (iSymbol < 0) return { parsed: grid.length - 1, valid: 0, sample: [] };
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 1; i < grid.length; i++) {
    const sym = String(grid[i][iSymbol] ?? '').trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return { parsed: grid.length - 1, valid: out.length, sample: out.slice(0, 5) };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  UNIVERSE + CANDLE DIAGNOSTIC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── 1. CSV file probe ──
  console.log('\n  ▸ Step 1 — CSV seed file probe');
  const fileExists = existsSync(args.csv);
  let fileSize = 0;
  if (fileExists) {
    try { fileSize = statSync(args.csv).size; } catch { /* ignore */ }
  }
  const csvRes = fileExists
    ? parseCsvSymbols(args.csv)
    : { parsed: 0, valid: 0, sample: [] as string[] };
  console.log(`     universe_path:   ${args.csv}`);
  console.log(`     file_exists:     ${fileExists}`);
  console.log(`     file_size_bytes: ${fileSize}`);
  console.log(`     parsed_symbols:  ${csvRes.parsed}`);
  console.log(`     valid_symbols:   ${csvRes.valid}`);
  console.log(`     sample:          ${csvRes.sample.join(', ')}`);

  // ── 2. q365_universe DB probe (pre-init) ──
  console.log('\n  ▸ Step 2 — q365_universe DB probe (pre-init)');
  let dbActiveCount = -1;
  let dbTotalCount  = -1;
  try {
    const { rows: t } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_universe`,
    );
    dbTotalCount = Number(t[0]?.c ?? 0);
    const { rows: a } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_universe WHERE is_active = 1`,
    );
    dbActiveCount = Number(a[0]?.c ?? 0);
  } catch (err: any) {
    console.warn(`     query failed: ${err?.message}`);
  }
  console.log(`     q365_universe_total:  ${dbTotalCount}`);
  console.log(`     q365_universe_active: ${dbActiveCount}`);
  console.log(`     min_required:         ${NIFTY500_MIN_SIZE}`);
  console.log(`     max_allowed:          ${NIFTY500_MAX_SIZE}`);

  // ── 3. initOnce() invocation ──
  console.log('\n  ▸ Step 3 — initOnce() (live universe load)');
  let initOk        = false;
  let initErrorMsg  = '';
  let finalSize     = 0;
  let universeAfter = 0;
  if (!args.noInit) {
    try {
      _resetNifty500CacheForTests();              // force fresh load even if cached
      const result = await initOnce();
      initOk    = true;
      finalSize = result.symbols.length;
    } catch (err: any) {
      initErrorMsg = err?.message ?? String(err);
    }
    universeAfter = DEFAULT_PHASE1_CONFIG.universe.length;
  } else {
    console.log('     SKIPPED (--no-init)');
  }
  console.log(`     init_succeeded:                  ${initOk}`);
  console.log(`     init_error:                      ${initErrorMsg || '(none)'}`);
  console.log(`     final_universe_size:             ${finalSize}`);
  console.log(`     DEFAULT_PHASE1_CONFIG.universe:  ${universeAfter}  (must match final_universe_size)`);
  console.log(`     isNifty500Initialized():         ${isNifty500Initialized()}`);

  // ── 4. market_data_daily candle probe ──
  console.log('\n  ▸ Step 4 — market_data_daily probe');
  let candleTotal      = -1;
  let candleSymbols    = -1;
  let candleLatest: any = null;
  let candleOldest: any = null;
  let perSymbolMedian  = -1;
  try {
    const { rows: c } = await db.query<{ c: number; sym: number; latest: any; oldest: any }>(
      `SELECT COUNT(*) AS c, COUNT(DISTINCT symbol) AS sym,
              MAX(ts) AS latest, MIN(ts) AS oldest
         FROM market_data_daily`,
    );
    candleTotal   = Number(c[0]?.c ?? 0);
    candleSymbols = Number(c[0]?.sym ?? 0);
    candleLatest  = c[0]?.latest ?? null;
    candleOldest  = c[0]?.oldest ?? null;
    if (candleSymbols > 0) {
      // Median bars per symbol — gives a feel for how many bars are
      // available without listing every symbol.
      const { rows: m } = await db.query<{ avg_bars: number }>(
        `SELECT AVG(cnt) AS avg_bars FROM (
            SELECT COUNT(*) AS cnt FROM market_data_daily GROUP BY symbol
         ) t`,
      );
      perSymbolMedian = Math.round(Number(m[0]?.avg_bars ?? 0));
    }
  } catch (err: any) {
    console.warn(`     query failed: ${err?.message}`);
  }
  const ageHrs = candleLatest != null
    ? Math.round(((Date.now() - new Date(candleLatest).getTime()) / 3_600_000) * 10) / 10
    : null;
  console.log(`     market_data_daily_total:    ${candleTotal}`);
  console.log(`     distinct_symbols:           ${candleSymbols}`);
  console.log(`     latest_bar_ts:              ${candleLatest ?? '(empty)'}`);
  console.log(`     oldest_bar_ts:              ${candleOldest ?? '(empty)'}`);
  console.log(`     latest_bar_age_hours:       ${ageHrs ?? 'n/a'}`);
  console.log(`     avg_bars_per_symbol:        ${perSymbolMedian}`);

  // ── 5. Verdict ──
  console.log('\n  ▸ Step 5 — verdict');
  const failures: string[] = [];

  if (!fileExists)              failures.push(`CSV missing at ${args.csv}`);
  if (csvRes.valid < NIFTY500_MIN_SIZE)
    failures.push(`CSV produced ${csvRes.valid} symbols, < ${NIFTY500_MIN_SIZE}`);
  if (dbActiveCount === 0)      failures.push('q365_universe(is_active=1) is empty');
  if (dbActiveCount > 0 && dbActiveCount < NIFTY500_MIN_SIZE)
    failures.push(`q365_universe has ${dbActiveCount} active rows, < ${NIFTY500_MIN_SIZE}`);
  if (!args.noInit && !initOk)  failures.push(`initOnce threw: ${initErrorMsg}`);
  if (!args.noInit && initOk && universeAfter < NIFTY500_MIN_SIZE)
    failures.push(
      `initOnce succeeded with ${finalSize} symbols but DEFAULT_PHASE1_CONFIG.universe.length=${universeAfter}` +
      ' — in-place hydration failed (check the dynamic-import warning in logs).',
    );
  if (candleTotal === 0)        failures.push('market_data_daily is empty');

  if (failures.length === 0) {
    console.log('     ✓ universe + candle pipeline are healthy');
    console.log(`       universe size: ${universeAfter}`);
    console.log(`       candle bars:   ${candleTotal} across ${candleSymbols} symbols`);
    process.exit(0);
  }
  for (const f of failures) console.log(`     ✗ ${f}`);
  console.log('');

  // ── 6. Recommended actions ──
  console.log('  ▸ Step 6 — recommended actions');
  if (!fileExists) {
    console.log('     1. Place the NSE NIFTY 500 list at ind_nifty500list.csv (repo root).');
    console.log('        Download: https://www.nseindia.com/products-services/indices-nifty500-index');
  }
  if (dbActiveCount === 0 || (dbActiveCount > 0 && dbActiveCount < NIFTY500_MIN_SIZE)) {
    console.log('     2. Seed the universe table:');
    console.log('          npx tsx scripts/loadNifty500.ts');
    console.log('        (or set UNIVERSE_AUTO_SEED_FROM_CSV=true and restart so initOnce auto-seeds)');
  }
  if (universeAfter < NIFTY500_MIN_SIZE && initOk) {
    console.log('     3. Restart the server — TRADEABLE_UNIVERSE in-place hydration ran but the');
    console.log('        constants module was loaded before initOnce. Restart picks up the new array.');
  }
  if (candleTotal === 0) {
    console.log('     4. Bootstrap candle data:');
    console.log('          npx tsx scripts/bootstrapNseData.ts        # one-shot full universe');
    console.log('          POST /api/run-signal-engine?force=true     # triggers refreshDailyCandles');
    console.log('        Or wait for the in-process candle scheduler (see workers/candleRefreshScheduler.ts).');
  }
  console.log('');

  process.exit(1);
}

main().catch((err) => {
  console.error('diagnose-universe script failed:', err);
  process.exit(2);
});
