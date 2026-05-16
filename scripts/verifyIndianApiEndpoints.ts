/**
 * verifyIndianApiEndpoints.ts — runs ONE call against every
 * endpoint marked `confirmed: false` in indianApiEndpoints.ts and
 * prints a copy-pastable verdict per endpoint.
 *
 *   Usage:
 *     # set the key one of two ways (NEVER commit it)
 *     # 1. via .env.local (already loaded if present)
 *     # 2. via shell:
 *     INDIANAPI_API_KEY=your_key npx tsx scripts/verifyIndianApiEndpoints.ts
 *
 *   What it does:
 *     - reads the endpoint catalogue
 *     - filters to confirmed:false entries
 *     - issues ONE call per endpoint with a representative payload
 *       (RELIANCE for stock_name, ['RELIANCE','TCS'] for batch)
 *     - records HTTP status, content-type, latency, and the first
 *       300 chars of the response body
 *     - emits a `[VERIFY] OK` or `[VERIFY] FAIL` line per endpoint
 *
 *   Cost: ~22 API calls total (one per endpoint). Trivial against
 *   the 100k/month plan.
 *
 *   Output: paste the script's output back to the assistant. The
 *   assistant will flip `confirmed: true` for OK rows and either
 *   fix the path or remove the entry for FAIL rows.
 *
 *   The script does NOT modify indianApiEndpoints.ts — flipping a
 *   flag based on automated parsing of the response body would be
 *   too aggressive. Human review of the JSON is the right gate.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';
dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });

import {
  INDIANAPI_BATCH_BODY_KEY,
  INDIANAPI_ENDPOINTS,
  getIndianApiConfig,
  type EndpointName,
  type EndpointSpec,
} from '@/lib/marketData/providers/indianApiEndpoints';

interface ProbeArgs {
  query?: Record<string, string>;
  body?:  unknown;
}

/** Representative arguments per endpoint. RELIANCE is used as the
 *  canary symbol because every Indian-equities plan has it. */
const PROBES: Partial<Record<EndpointName, ProbeArgs>> = {
  stockDetail:       { query: { name: 'RELIANCE' } },
  trending:          {},
  usage:             {},
  // `period` enum: '1m' | '6m' | '1yr' | '3yr' | '5yr' | '10yr' | 'max'
  // `filter` is required by the upstream — 'price' is the canonical
  // OHLCV filter. Other filter values may exist on richer plans.
  historical:        { query: { stock_name: 'RELIANCE', period: '1yr', filter: 'price' } },
  industrySearch:    { query: { query: 'reliance' } },
  // `age` enum: 'OneWeekAgo' | 'ThirtyDaysAgo' | 'SixtyDaysAgo' |
  // 'NinetyDaysAgo' | 'Current'. 'Current' is the cheapest snapshot.
  stockForecasts:    { query: { stock_id: 'RELIANCE', measure_code: 'EPS', period_type: 'Annual', data_type: 'Actuals', age: 'Current' } },
  stockTargetPrice:  { query: { stock_id: 'RELIANCE' } },
  historicalStats:   { query: { stock_name: 'RELIANCE', stats: 'quarter_results' } },
  mutualFundSearch:  { query: { query: 'sbi' } },
  mutualFunds:       {},
  fiftyTwoWeekHL:    {},
  nseMostActive:     {},
  bseMostActive:     {},
  priceShockers:     {},
  commodities:       {},
  marketNews:        {},
  companyNews:       { query: { stock_name: 'RELIANCE' } },
  // `category` is required — 'economy' is the adapter default.
  aiCuratedNews:     { query: { category: 'economy' } },
};

interface ProbeResult {
  name:        EndpointName;
  spec:        EndpointSpec;
  status:      number | 'NETWORK_ERROR';
  contentType: string;
  ms:          number;
  ok:          boolean;
  bodyHead:    string;
  errorMsg?:   string;
}

async function probe(name: EndpointName, spec: EndpointSpec, args: ProbeArgs): Promise<ProbeResult> {
  const cfg = getIndianApiConfig();
  if (!cfg.apiKey) {
    return {
      name, spec,
      status: 'NETWORK_ERROR',
      contentType: '', ms: 0, ok: false, bodyHead: '',
      errorMsg: 'INDIANAPI_API_KEY not set — cannot probe',
    };
  }

  const url = new URL(spec.path, cfg.baseUrl);
  for (const [k, v] of Object.entries(args.query ?? {})) {
    url.searchParams.set(k, v);
  }

  let init: RequestInit = {
    method: spec.method,
    headers: { 'X-API-Key': cfg.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  };
  if (spec.method === 'POST') {
    let payload: unknown = undefined;
    if (spec.body === 'stock_symbols')      payload = { [INDIANAPI_BATCH_BODY_KEY]: args.body ?? [] };
    else if (spec.body === 'stock_name')    payload = { stock_name: args.body ?? '' };
    else if (spec.body === 'free')          payload = args.body ?? {};
    else                                     payload = args.body;
    init = {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(url, init);
    const ms = Date.now() - t0;
    const text = await res.text();
    return {
      name, spec,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      ms,
      ok: res.status >= 200 && res.status < 300,
      bodyHead: text.slice(0, 300).replace(/\s+/g, ' '),
    };
  } catch (err) {
    return {
      name, spec,
      status: 'NETWORK_ERROR',
      contentType: '', ms: Date.now() - t0,
      ok: false, bodyHead: '',
      errorMsg: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const cfg = getIndianApiConfig();
  console.log(`=== verifyIndianApiEndpoints — base=${cfg.baseUrl} keyPresent=${!!cfg.apiKey} ===`);
  console.log('');

  const targets = (Object.entries(INDIANAPI_ENDPOINTS) as Array<[EndpointName, EndpointSpec]>)
    .filter(([, spec]) => !spec.confirmed);

  if (targets.length === 0) {
    console.log('[VERIFY] all catalog endpoints are confirmed: true — re-probing every endpoint to detect upstream regressions');
    targets.push(...(Object.entries(INDIANAPI_ENDPOINTS) as Array<[EndpointName, EndpointSpec]>));
    console.log('');
  }

  const results: ProbeResult[] = [];
  for (const [name, spec] of targets) {
    const args = PROBES[name] ?? {};
    process.stdout.write(`[VERIFY] ${name.padEnd(22)} ${spec.method.padEnd(4)} ${spec.path.padEnd(45)} `);
    const r = await probe(name, spec, args);
    if (r.status === 'NETWORK_ERROR') {
      console.log(`FAIL  network=${r.errorMsg}`);
    } else if (r.ok) {
      console.log(`OK    status=${r.status}  ms=${r.ms}  ct=${r.contentType.slice(0, 30)}`);
    } else {
      console.log(`FAIL  status=${r.status}  ms=${r.ms}  ct=${r.contentType.slice(0, 30)}`);
    }
    results.push(r);
    // Avoid bursting the upstream — 750ms gap.
    await new Promise((r2) => setTimeout(r2, 750));
  }

  console.log('');
  console.log('=== detailed bodies (first 300 chars each) ===');
  for (const r of results) {
    console.log(`--- ${r.name} (${r.status}) ---`);
    if (r.errorMsg) console.log(`  err: ${r.errorMsg}`);
    if (r.bodyHead) console.log(`  body: ${r.bodyHead}`);
    console.log('');
  }

  // Summary
  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  console.log('='.repeat(72));
  console.log(`[VERIFY] SUMMARY  ok=${okCount}  fail=${failCount}  total=${results.length}`);
  console.log('');
  console.log('Next step: paste this entire output to the assistant.');
  console.log(' • OK rows  → assistant flips `confirmed: true` in indianApiEndpoints.ts');
  console.log(' • FAIL rows → assistant either fixes the path or removes the endpoint');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[VERIFY] script failed:', err);
  process.exit(1);
});
