/// <reference types="node" />
/**
 * scripts/testIndicatorEngine.ts
 *
 * Runs the indicator engine against:
 *   1. Real Yahoo data for RELIANCE and NLCINDIA
 *   2. A short synthetic series (5 bars) — confirms the
 *      insufficient-history paths return nulls + warnings
 *   3. An empty series — confirms the no-candles fast path
 *
 * Run:  npx tsx scripts/testIndicatorEngine.ts
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { fetchYahooBundleBatch } from '../src/lib/scanner/yahooDataService';
import {
  computeIndicators,
  type IndicatorSnapshot,
} from '../src/lib/scanner/indicatorEngine';

const SEP = '─'.repeat(72);

function fmt(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}
function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-IN');
}

function printSnapshot(label: string, s: IndicatorSnapshot): void {
  console.log(SEP);
  console.log(`case            : ${label}`);
  console.log(`bar             : ${s.date ?? '—'}  candles=${s.candleCount}`);
  console.log(`price           : open=${fmt(s.open)}  high=${fmt(s.high)}  ` +
              `low=${fmt(s.low)}  close=${fmt(s.close)}  prevClose=${fmt(s.prevClose)}  ` +
              `volume=${fmtCount(s.volume)}`);
  console.log(`trend           : ema20=${fmt(s.ema20)}  ema50=${fmt(s.ema50)}  ` +
              `distEma20=${fmt(s.distEma20Pct, 2)}%  distEma50=${fmt(s.distEma50Pct, 2)}%`);
  console.log(`momentum        : rsi14=${fmt(s.rsi14, 2)}`);
  console.log(`volume          : avgVolume20=${fmtCount(s.avgVolume20)}`);
  console.log(`range20         : high20=${fmt(s.high20)}  low20=${fmt(s.low20)}`);
  console.log(`volatility      : atr14=${fmt(s.atr14, 4)}  ` +
              `volatilityPct(σ20)=${fmt(s.volatilityPct, 3)}%`);
  console.log(`gap             : ${fmt(s.gapPct, 3)}%`);
  console.log(`warnings        : ${s.warnings.length === 0 ? '(none)' : s.warnings.join(', ')}`);
}

async function main(): Promise<void> {
  // ── Real data: RELIANCE, NLCINDIA ───────────────────────────────
  const symbols = ['RELIANCE', 'NLCINDIA'];
  const bundles = await fetchYahooBundleBatch(symbols, {
    concurrency: 2, perSymbolDelayMs: 50, range: '6mo', interval: '1d',
  });
  for (const r of bundles) {
    if (!r.ok || !r.data) {
      console.log(SEP);
      console.log(`${r.meta.symbol}: fetch failed — [${r.error?.code}] ${r.error?.message}`);
      continue;
    }
    printSnapshot(`real: ${r.data.symbol}`, computeIndicators(r.data.candles));
  }

  // ── Synthetic: 5 bars (everything insufficient) ─────────────────
  const synth5 = [
    { date: '2025-01-01', open: 100, high: 101, low:  99, close: 100, volume: 1000 },
    { date: '2025-01-02', open: 100, high: 102, low:  99, close: 101, volume: 1100 },
    { date: '2025-01-03', open: 101, high: 103, low: 100, close: 102, volume: 1200 },
    { date: '2025-01-04', open: 102, high: 104, low: 101, close: 103, volume: 1300 },
    { date: '2025-01-05', open: 103, high: 105, low: 102, close: 104, volume: 1400 },
  ];
  printSnapshot('synth: 5 bars (short series)', computeIndicators(synth5));

  // ── Empty series ───────────────────────────────────────────────
  printSnapshot('synth: empty', computeIndicators([]));

  console.log(SEP);
}

main().catch((err) => { console.error('failed:', err); process.exit(1); });
