/// <reference types="node" />
/**
 * scripts/testPreFilterEngine.ts
 *
 * Exercises src/lib/scanner/preFilterEngine.ts against:
 *   1. Real Yahoo data for 3 symbols (RELIANCE, TCS, NLCINDIA)
 *   2. Six synthetic edge cases (one per reject rule)
 *
 * Run:  npx tsx scripts/testPreFilterEngine.ts
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { fetchYahooBundleBatch, type NormalizedCandle } from '../src/lib/scanner/yahooDataService';
import {
  runPreFilter,
  DEFAULT_PRE_FILTER_CONFIG,
  type PreFilterResult,
} from '../src/lib/scanner/preFilterEngine';

const SEP = '─'.repeat(72);

function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}

function printResult(label: string, r: PreFilterResult): void {
  console.log(SEP);
  console.log(`case      : ${label}`);
  console.log(`passed    : ${r.passed}`);
  console.log(`metrics   : close=${fmtNum(r.metrics.close)}  ` +
              `avgVol20=${r.metrics.avgVolume20 != null ? Math.round(r.metrics.avgVolume20).toLocaleString('en-IN') : '—'}  ` +
              `tradedVal20=${r.metrics.tradedValue20 != null ? '₹' + (r.metrics.tradedValue20 / 1e7).toFixed(2) + 'Cr' : '—'}  ` +
              `gap=${fmtNum(r.metrics.gapPct)}%`);
  if (r.reasons.length === 0) {
    console.log(`reasons   : (none)`);
  } else {
    console.log(`reasons   :`);
    for (const reason of r.reasons) console.log(`  • ${reason}`);
  }
}

// ── Synthetic candle factories ────────────────────────────────────

function makeFlatSeries(
  n: number,
  close: number,
  volume: number,
): NormalizedCandle[] {
  const out: NormalizedCandle[] = [];
  const start = Date.UTC(2025, 9, 1);
  for (let i = 0; i < n; i++) {
    const ts = new Date(start + i * 86_400_000);
    out.push({
      date:   ts.toISOString().slice(0, 10),
      open:   close,
      high:   close * 1.005,
      low:    close * 0.995,
      close,
      volume,
    });
  }
  return out;
}

function withGap(
  series: NormalizedCandle[],
  gapPct: number,
  todayVolMult: number,
): NormalizedCandle[] {
  const copy = series.slice();
  const prev = copy[copy.length - 2];
  const last = { ...copy[copy.length - 1] };
  const newOpen = prev.close * (1 + gapPct / 100);
  last.open   = newOpen;
  last.high   = Math.max(newOpen, last.close) * 1.01;
  last.low    = Math.min(newOpen, last.close) * 0.99;
  last.volume = Math.round(prev.volume * todayVolMult);
  copy[copy.length - 1] = last;
  return copy;
}

// ── Synthetic test cases ──────────────────────────────────────────

function runSyntheticCases(): void {
  console.log('\n# SYNTHETIC EDGE CASES');

  // 1. Insufficient history
  printResult('synth: 30 candles only',
    runPreFilter(makeFlatSeries(30, 250, 500_000)));

  // 2. Low price
  printResult('synth: 60 candles, close ₹15',
    runPreFilter(makeFlatSeries(60, 15, 500_000)));

  // 3. Low avg volume
  printResult('synth: 60 candles, close ₹250, vol 50k',
    runPreFilter(makeFlatSeries(60, 250, 50_000)));

  // 4. Low traded value (close × avg too small even though both pass independently)
  //    close=25, avg=200k → tradedValue = ₹50L (below ₹1Cr default)
  printResult('synth: 60 candles, close ₹25, vol 200k → tradedValue ₹50L',
    runPreFilter(makeFlatSeries(60, 25, 200_000)));

  // 5. Abnormal gap, no volume confirmation
  printResult('synth: +25% gap, today vol = 1.0× avg',
    runPreFilter(withGap(makeFlatSeries(60, 250, 500_000), 25, 1.0)));

  // 6. Abnormal gap, volume DOES confirm — should pass the gap rule
  printResult('synth: +25% gap, today vol = 2.5× avg (volume confirms)',
    runPreFilter(withGap(makeFlatSeries(60, 250, 500_000), 25, 2.5)));

  // 7. Missing data on latest bar
  const broken = makeFlatSeries(60, 250, 500_000);
  broken[broken.length - 1] = { ...broken[broken.length - 1], close: NaN as unknown as number, volume: 0 };
  printResult('synth: latest bar close=NaN, volume=0',
    runPreFilter(broken));

  // 8. Empty series
  printResult('synth: empty array',
    runPreFilter([]));
}

// ── Real-data cases ───────────────────────────────────────────────

async function runRealCases(): Promise<void> {
  const symbols = ['RELIANCE', 'TCS', 'NLCINDIA'];
  console.log(`\n# REAL YAHOO DATA: ${symbols.join(', ')}`);
  const bundles = await fetchYahooBundleBatch(symbols, {
    concurrency: 3, perSymbolDelayMs: 50, range: '6mo', interval: '1d',
  });
  for (const r of bundles) {
    if (!r.ok || !r.data) {
      console.log(SEP);
      console.log(`case      : real ${r.meta.symbol}`);
      console.log(`fetch failed: [${r.error?.code}] ${r.error?.message}`);
      continue;
    }
    printResult(`real: ${r.data.symbol} (${r.data.candles.length} bars)`,
      runPreFilter(r.data.candles));
  }
}

async function main(): Promise<void> {
  console.log('config:', DEFAULT_PRE_FILTER_CONFIG);
  runSyntheticCases();
  await runRealCases();
  console.log(SEP);
  console.log('done.');
}

main().catch((err) => {
  console.error('test failed:', err);
  process.exit(1);
});
