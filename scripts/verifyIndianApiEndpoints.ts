// ════════════════════════════════════════════════════════════════
//  verifyIndianApiEndpoints.ts — STAGING probe (manual, never CI)
//
//  Verifies which IndianAPI endpoints respond on the configured plan
//  host with the configured key. Spends a handful of real API calls —
//  run consciously, not on a schedule.
//
//  Usage:
//    INDIANAPI_API_KEY=... npx tsx scripts/verifyIndianApiEndpoints.ts
//    npx tsx scripts/verifyIndianApiEndpoints.ts --symbol RELIANCE
// ════════════════════════════════════════════════════════════════

import * as IndianApi from '@/providers/adapters/IndianAPIAdapter';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';

const argSymbol = (() => {
  const i = process.argv.indexOf('--symbol');
  return i >= 0 ? (process.argv[i + 1] ?? 'RELIANCE') : 'RELIANCE';
})();

interface ProbeResult {
  endpoint: string;
  ok: boolean;
  detail: string;
}

async function probe(name: string, fn: () => Promise<string>): Promise<ProbeResult> {
  try {
    const detail = await fn();
    return { endpoint: name, ok: true, detail };
  } catch (err) {
    return {
      endpoint: name,
      ok: false,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

async function main(): Promise<void> {
  const cfg = getIndianApiConfig();
  if (!cfg.apiKey) {
    console.error('INDIANAPI_API_KEY not set — aborting (no probes attempted).');
    process.exit(2);
  }
  console.log(`Probing ${cfg.baseUrl} (timeout ${cfg.timeoutMs}ms, symbol ${argSymbol})\n`);

  const results: ProbeResult[] = [];

  results.push(await probe('/stock (detail)', async () => {
    const { snapshot, intel } = await IndianApi.getStockDetail(argSymbol, 'verify-script');
    return `price=${snapshot.price} company="${intel.companyName}"`;
  }));

  results.push(await probe('/trending + /NSE_most_active (movers)', async () => {
    const movers = await IndianApi.getMovers('verify-script');
    return `gainers=${movers.gainers.length} losers=${movers.losers.length} active=${movers.mostActive.length}`;
  }));

  results.push(await probe('/historical_data', async () => {
    const series = await IndianApi.getHistorical(argSymbol, '1mo', 'verify-script');
    return `candles=${series.candles.length}`;
  }));

  results.push(await probe('POST /nse_stock_batch_live_price (plan-dependent)', async () => {
    const available = await IndianApi.probeBatchEndpoint([argSymbol, 'TCS']);
    return available ? 'AVAILABLE — batch mode usable' : 'NOT AVAILABLE (404) — per-symbol mode';
  }));

  results.push(await probe('/usage', async () => {
    const usage = await IndianApi.getVendorUsage('verify-script');
    return JSON.stringify(usage).slice(0, 200);
  }));

  console.log('');
  let failures = 0;
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.endpoint}`);
    console.log(`    ${r.detail}\n`);
    if (!r.ok) failures += 1;
  }
  console.log(`${results.length - failures}/${results.length} endpoints verified.`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
