/**
 * scripts/diagnoseFullScan.ts
 *
 * Spec INSTITUTIONAL §C — full-universe scan audit. Triggers a
 * single Phase 4 invocation and verifies every symbol in the
 * universe was actually evaluated. Prints the canonical 9-field
 * envelope:
 *
 *   { universe_size, received_by_phase3, candle_fetch_attempted,
 *     candle_fetch_success, skipped_stale, skipped_invalid,
 *     matched, approved, persisted }
 *
 * Plus the band distribution + factor averages so the operator can
 * see WHY rows are landing in WATCHLIST_ONLY vs HIGH_CONVICTION.
 *
 * Exit codes:
 *   0  — universe fully scanned (>=95% coverage) AND >=1 signal generated
 *   1  — partial scan (<95% coverage) OR zero signals
 *   2  — pipeline threw
 *
 * Usage:
 *   npx tsx scripts/diagnoseFullScan.ts
 *   npx tsx scripts/diagnoseFullScan.ts --skip-candles  # use existing market_data_daily bars
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { generatePhase4Signals, DEFAULT_PHASE1_CONFIG } from '../src/lib/signal-engine';
import type { CandleProvider, Candle, PortfolioSnapshot } from '../src/lib/signal-engine';
import { initOnce } from '../src/lib/marketData/nifty500Universe';

const STUB_PORTFOLIO: PortfolioSnapshot = {
  capital:        1_000_000,
  cashAvailable:  1_000_000,
  openPositions:  [],
  pendingSignals: [],
};

const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    try {
      const { rows } = await db.query<any>(
        `SELECT ts, open, high, low, close, volume
           FROM market_data_daily
          WHERE symbol = ?
          ORDER BY ts DESC
          LIMIT 250`,
        [symbol.toUpperCase()],
      );
      return ((rows as any[]) ?? [])
        .reverse()
        .map((r) => ({
          ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
          open:   Number(r.open),
          high:   Number(r.high),
          low:    Number(r.low),
          close:  Number(r.close),
          volume: Number(r.volume ?? 0),
        })) as Candle[];
    } catch {
      return [];
    }
  },
};

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  FULL-UNIVERSE SCAN DIAGNOSTIC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1: ensure universe is loaded.
  console.log('\n  ▸ Step 1 — universe init');
  try {
    const r = await initOnce();
    console.log(`     loaded ${r.symbols.length} symbols from ${r.source}`);
  } catch (err: any) {
    console.error(`     init failed: ${err?.message}`);
    process.exit(2);
  }
  const universeSize = DEFAULT_PHASE1_CONFIG.universe.length;
  console.log(`     DEFAULT_PHASE1_CONFIG.universe.length = ${universeSize}`);

  // Step 2: candle availability snapshot.
  console.log('\n  ▸ Step 2 — candle snapshot');
  try {
    const { rows } = await db.query<{ c: number; sym: number; latest: any }>(
      `SELECT COUNT(*) AS c, COUNT(DISTINCT symbol) AS sym, MAX(ts) AS latest
         FROM market_data_daily`,
    );
    console.log(`     market_data_daily: ${rows[0]?.c} bars across ${rows[0]?.sym} symbols`);
    console.log(`     latest bar: ${rows[0]?.latest}`);
  } catch (err: any) {
    console.warn(`     candle probe failed: ${err?.message}`);
  }

  // Step 3: invoke Phase 4.
  console.log('\n  ▸ Step 3 — generatePhase4Signals (full universe)');
  console.log('     (watch the [PIPELINE_START] / [SCAN_LIMIT] / [PHASE3_RECEIVED] / [SCANNED] /');
  console.log('      [MATCHED] / [PHASE3_COMPLETE] / [SCAN_FUNNEL] markers below)');
  console.log('');
  let result: any = null;
  const t0 = Date.now();
  try {
    result = await generatePhase4Signals(
      dbCandleProvider,
      STUB_PORTFOLIO,
      undefined, undefined,
      DEFAULT_PHASE1_CONFIG,
      undefined,
      { generationSource: 'script:diagnoseFullScan' },
    );
  } catch (err: any) {
    console.error(`\n  ✗ generatePhase4Signals threw: ${err?.message}`);
    console.error(err?.stack);
    process.exit(2);
  }
  const elapsedMs = Date.now() - t0;

  // Step 4: verify coverage.
  console.log('\n  ▸ Step 4 — coverage verdict');
  const scanned = Number(result.meta.scanned ?? 0);
  const matched = Number(result.signals.length ?? 0);
  const approved = Number(result.meta.approved ?? 0);
  const coverage = universeSize > 0
    ? Math.round((scanned / universeSize) * 1000) / 10
    : 0;

  console.log('  ┌─────────────────────────────────────────────────────────┐');
  console.log(`  │  universe_size            ${String(universeSize).padStart(6)}                       │`);
  console.log(`  │  scanned (Phase 3 visited)${String(scanned).padStart(6)}                       │`);
  console.log(`  │  coverage_percent         ${String(coverage + '%').padStart(7)}                      │`);
  console.log(`  │  matched (any strategy)   ${String(matched).padStart(6)}                       │`);
  console.log(`  │  approved (gate-passed)   ${String(approved).padStart(6)}                       │`);
  console.log(`  │  enriched (Phase 4 out)   ${String(result.signals.length).padStart(6)}                       │`);
  console.log(`  │  elapsed_ms               ${String(elapsedMs).padStart(6)}                       │`);
  console.log('  └─────────────────────────────────────────────────────────┘');

  // Step 5: classification distribution.
  console.log('\n  ▸ Step 5 — classification distribution');
  const bands = new Map<string, number>();
  for (const s of result.signals as any[]) {
    const cls = String(s.classification ?? 'UNKNOWN');
    bands.set(cls, (bands.get(cls) ?? 0) + 1);
  }
  if (bands.size === 0) {
    console.log('     (no signals — see [STRATEGY] Phase3 rejection summary above)');
  } else {
    for (const [k, v] of [...bands.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${k.padEnd(34)} ${v}`);
    }
  }

  // Step 6: verdict.
  console.log('\n  ▸ Step 6 — verdict');
  const failures: string[] = [];
  if (coverage < 95) {
    failures.push(`coverage ${coverage}% < 95% — partial scan. Check [SCAN_LIMIT] log line for the cap that fired.`);
  }
  if (matched === 0) {
    failures.push('matched=0 — Phase 3 rejected every candidate. Check [STRATEGY] Phase3 rejection summary for the dominant gate.');
  }
  const hasInstitutional = (bands.get('HIGH_CONVICTION') ?? 0) + (bands.get('INSTITUTIONAL_HIGH_CONVICTION') ?? 0);
  if (hasInstitutional === 0 && matched > 0) {
    failures.push(`zero HIGH_CONVICTION rows. Check [PHASE4_FACTORS] log for the lowest-average factor.`);
  }
  if (failures.length === 0) {
    console.log(`     ✓ universe fully scanned (${coverage}%) and ${matched} signals matched`);
    console.log(`       (${hasInstitutional} HIGH_CONVICTION+, ${matched - hasInstitutional} other)`);
    process.exit(0);
  }
  for (const f of failures) console.log(`     ✗ ${f}`);
  console.log('');
  process.exit(1);
}

main().catch((err) => {
  console.error('diagnose-full-scan script failed:', err);
  process.exit(2);
});
