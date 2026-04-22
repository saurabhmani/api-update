// ════════════════════════════════════════════════════════════════
//  Yahoo Finance — tertiary fallback
//
//  Called from getLivePrice ONLY when both the Kite WebSocket
//  is inactive AND NSE returned no usable price. Yahoo quotes
//  for Indian equities are ~15 minutes delayed but the endpoint
//  is always reachable without auth, which makes it a reliable
//  last-resort.
//
//  Uses query1 with automatic failover to query2 on retry —
//  different edges often resolve transient rate-limit hiccups.
// ════════════════════════════════════════════════════════════════

import type { PriceResponse } from './getLivePrice';

// 1 second per the per-provider timeout rule. Yahoo normally
// answers in 200-400ms; >1s = either rate-limited or edge-routing
// degraded, both of which are better handled by failing fast and
// letting the cache absorb the gap than by waiting.
const TIMEOUT_MS = 1000;

const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://finance.yahoo.com/',
  Origin:  'https://finance.yahoo.com',
};

interface YahooChartResult {
  meta?: {
    regularMarketPrice?:         number;
    previousClose?:              number;
    regularMarketChange?:        number;
    regularMarketChangePercent?: number;
  };
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[];
    error?:  { code: string; description: string };
  };
}

async function fetchYahooFromHost(host: string, symbol: string): Promise<PriceResponse> {
  // NSE equities map to <SYMBOL>.NS on Yahoo
  const yahooSym = symbol.toUpperCase().endsWith('.NS')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.NS`;

  // Endpoint choice matters for accuracy:
  //
  //   /v8/finance/chart?interval=1d  returns the rolling intraday
  //     bar; its `close` freezes at the last continuous-session
  //     trade (~15:29:59 IST) and does NOT reflect NSE's closing
  //     auction. Symptom: LUPIN shows 2326.10 here but Google
  //     shows 2322.50 (the 15:40 official close).
  //
  //   /v8/finance/chart?interval=1d  ALSO carries `meta.regularMarketPrice`
  //     which, once the exchange has closed and the auction has settled,
  //     IS the official closing print. Prefer that over
  //     `result.indicators.quote[0].close[-1]` (the continuous-session
  //     tick) by a wide margin.
  //
  // So we stick with the chart endpoint (single request gives us
  // both OHLC for ingest and regularMarketPrice for the live cell)
  // but read meta.regularMarketPrice first. This change alone
  // closes the ~₹3-4 gap between our UI and Google for equities
  // during the close-of-day window.
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=5d`;

  const res = await fetch(url, {
    headers: YAHOO_HEADERS,
    signal:  AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    return { price: null, source: 'yahoo', error: `http ${res.status}` };
  }

  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result?.meta) {
    return {
      price:  null,
      source: 'yahoo',
      error:  json.chart?.error?.description ?? 'no meta',
    };
  }

  const meta = result.meta;
  // Prefer the post-auction settled price (regularMarketPrice) over
  // the last continuous-session trade. previousClose is last-resort.
  const price = meta.regularMarketPrice ?? meta.previousClose ?? null;
  if (!price) {
    return { price: null, source: 'yahoo', error: 'no price in meta' };
  }

  return {
    price,
    change:  meta.regularMarketChange,
    pChange: meta.regularMarketChangePercent,
    source:  'yahoo',
  };
}

export async function fetchFromYahoo(symbol: string): Promise<PriceResponse> {
  // Tripwire: only MarketDataProvider (via withProviderFrame) + the
  // YahooAdapter that it drives are authorized to call this function.
  // Mode off by default; set ENFORCE_PROVIDER=warn in staging / throw
  // in CI/tests to catch regressions.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assertProviderFrame } = require('./enforcer') as typeof import('./enforcer');
  assertProviderFrame('fetchFromYahoo');

  try {
    const first = await fetchYahooFromHost('query1.finance.yahoo.com', symbol);
    if (first.price != null) return first;
    // Retry against query2 — different edge, often resolves transient failures
    const retry = await fetchYahooFromHost('query2.finance.yahoo.com', symbol);
    return retry;
  } catch (err: any) {
    return { price: null, source: 'yahoo', error: err?.message ?? 'fetch failed' };
  }
}
