/// <reference types="node" />
/**
 * scripts/testYahooDataService.ts
 *
 * Smoke test for src/lib/scanner/yahooDataService.ts. Hits Yahoo for
 * RELIANCE, TCS and NLCINDIA (override the list with CLI args) and
 * prints latest price, candle count, first/last bars, and timing.
 *
 * Usage
 *   npx tsx scripts/testYahooDataService.ts
 *   npx tsx scripts/testYahooDataService.ts RELIANCE TCS NLCINDIA HDFCBANK
 *   YAHOO_BREAKER_DISABLED=1 npx tsx scripts/testYahooDataService.ts
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import {
  fetchYahooBundleBatch,
  type YahooFetchResult,
  type YahooBundle,
} from '../src/lib/scanner/yahooDataService';

const DEFAULT_SYMBOLS = ['RELIANCE', 'TCS', 'NLCINDIA'];

function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}

function printResult(r: YahooFetchResult<YahooBundle>): void {
  const sep = '─'.repeat(70);
  console.log(sep);
  console.log(`symbol         : ${r.meta.symbol}  (yahoo: ${r.meta.yahooSym})`);
  console.log(`ok             : ${r.ok}`);
  console.log(`attempts       : ${r.meta.attempts}`);
  console.log(`host           : ${r.meta.host ?? '—'}`);
  console.log(`elapsedMs      : ${r.meta.elapsedMs}`);

  if (!r.ok || !r.data) {
    console.log(`error          : [${r.error?.code}] ${r.error?.message}` +
      (r.error?.httpStatus ? ` (status=${r.error.httpStatus})` : ''));
    return;
  }

  const d = r.data;
  console.log(`latestPrice    : ${fmtNum(d.latestPrice)}`);
  console.log(`previousClose  : ${fmtNum(d.previousClose)}`);
  console.log(`changeAbs      : ${fmtNum(d.changeAbs)}`);
  console.log(`changePercent  : ${fmtNum(d.changePercent, 3)}%`);
  console.log(`marketTime     : ${d.marketTime ? new Date(d.marketTime).toISOString() : '—'}`);
  console.log(`candles        : ${d.candles.length}`);

  if (d.candles.length > 0) {
    const first = d.candles[0];
    const last  = d.candles[d.candles.length - 1];
    console.log(
      `first bar      : ${first.date}  ` +
      `O=${fmtNum(first.open)} H=${fmtNum(first.high)} L=${fmtNum(first.low)} ` +
      `C=${fmtNum(first.close)} V=${first.volume}`,
    );
    console.log(
      `last bar       : ${last.date}  ` +
      `O=${fmtNum(last.open)} H=${fmtNum(last.high)} L=${fmtNum(last.low)} ` +
      `C=${fmtNum(last.close)} V=${last.volume}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const symbols = args.length > 0 ? args : DEFAULT_SYMBOLS;

  console.log(`[test] symbols: ${symbols.join(', ')}`);
  const t0 = Date.now();
  const results = await fetchYahooBundleBatch(symbols, {
    concurrency: Math.min(symbols.length, 4),
    perSymbolDelayMs: 50,
    timeoutMs:    8_000,
    maxAttempts:  3,
    backoffBaseMs: 250,
    range:    '6mo',
    interval: '1d',
  });

  for (const r of results) printResult(r);

  const sep = '─'.repeat(70);
  const okCount  = results.filter((r) => r.ok).length;
  const elapsed  = Date.now() - t0;
  console.log(sep);
  console.log(`[test] done  ok=${okCount}/${results.length}  total=${elapsed}ms`);
  process.exit(okCount === results.length ? 0 : 2);
}

main().catch((err) => {
  console.error('[test] failed unexpectedly:', err);
  process.exit(1);
});
