// ════════════════════════════════════════════════════════════════
//  yahooCandles — daily OHLC from Yahoo Finance chart endpoint
//
//  The SOLE historical-bar upstream. Real-time pricing comes from
//  Kite (WebSocket ticks); historical bars come from Yahoo. No
//  other providers are permitted.
//
//  Contract:
//    fetchYahooCandles('RELIANCE', { range: '1y', interval: '1d' })
//      → { ok: true,  candles: OhlcBar[], source: 'yahoo' }
//      → { ok: false, reason: string,     source: 'yahoo' }
//
//  Caller is responsible for skipping failed symbols. This helper
//  NEVER throws — every failure path returns `{ ok: false }` so the
//  bulk-refresh loop can continue without a try/catch at every call.
//
//  Indian equities are mapped to `<SYMBOL>.NS` on Yahoo. Indices and
//  other instrument types are out of scope for this helper.
// ════════════════════════════════════════════════════════════════

export interface OhlcBar {
  /** UTC epoch milliseconds — matches Kite's historical timestamps. */
  ts:     number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export type CandleSource = 'yahoo';

export type CandleFetchResult =
  | { ok: true;  candles: OhlcBar[]; source: CandleSource }
  | { ok: false; reason: string;     source: CandleSource };

import { toYahooSymbol, isPreEncodedYahoo } from './symbolNormalize';

export interface YahooCandleOpts {
  /** Yahoo-style range code. Default `1y` — enough to warm the
   *  signal engine's 200-bar indicator window. */
  range?:    '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y';
  /** Bar interval. Engine only uses `1d`. */
  interval?: '1d' | '1wk' | '1mo';
}

const TIMEOUT_MS = 8_000;

const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://finance.yahoo.com/',
  Origin:  'https://finance.yahoo.com',
};

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      // meta.regularMarketPrice is the post-auction settled close
      // (NSE's official closing price, set by the 15:40 auction).
      // indicators.quote[].close[-1] is only the last continuous-
      // session trade at ~15:29:59 and is typically ₹2–5 off for
      // liquid large-caps. Prefer meta for the most-recent bar.
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
      };
      indicators?: {
        quote?: Array<{
          open?:   (number | null)[];
          high?:   (number | null)[];
          low?:    (number | null)[];
          close?:  (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { code: string; description: string };
  };
}

async function fetchOnce(
  host:     string,
  symbol:   string,
  range:    string,
  interval: string,
): Promise<CandleFetchResult> {
  const yahooSym = toYahooSymbol(symbol);

  // Symbols with `&` are pre-encoded as `%26` in the map.
  // encodeURIComponent would double-encode to `%2526` → 404.
  const encodedSym = isPreEncodedYahoo(yahooSym)
    ? yahooSym
    : encodeURIComponent(yahooSym);

  const url =
    `https://${host}/v8/finance/chart/${encodedSym}` +
    `?interval=${interval}&range=${range}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: YAHOO_HEADERS,
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, source: 'yahoo', reason: `fetch error: ${(err as Error).message}` };
  }

  if (!res.ok) {
    return { ok: false, source: 'yahoo', reason: `http ${res.status}` };
  }

  let json: YahooChartResponse;
  try {
    json = (await res.json()) as YahooChartResponse;
  } catch (err) {
    return { ok: false, source: 'yahoo', reason: `json parse: ${(err as Error).message}` };
  }

  const result = json.chart?.result?.[0];
  if (!result) {
    return {
      ok: false,
      source: 'yahoo',
      reason: json.chart?.error?.description ?? 'no result',
    };
  }

  const ts    = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  if (!quote || ts.length === 0) {
    return { ok: false, source: 'yahoo', reason: 'empty chart' };
  }

  const candles: OhlcBar[] = [];
  const len = ts.length;
  for (let i = 0; i < len; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      // Yahoo gives seconds; engine expects ms.
      ts:     ts[i] * 1_000,
      open:   Number(o),
      high:   Number(h),
      low:    Number(l),
      close:  Number(c),
      volume: v == null ? 0 : Number(v),
    });
  }

  if (candles.length === 0) {
    return { ok: false, source: 'yahoo', reason: 'no valid bars' };
  }

  // Override the LATEST bar's close with meta.regularMarketPrice
  // when available. This captures the NSE closing-auction print
  // (the number Google shows) instead of the 15:29:59 continuous-
  // session last trade (the number indicators.quote.close holds).
  // Only applied to the most recent bar — historical bars in the
  // series are already auction-settled.
  const rmp = result.meta?.regularMarketPrice;
  if (rmp != null && Number.isFinite(rmp) && rmp > 0) {
    const last = candles[candles.length - 1];
    if (last) {
      // Guard: only replace when the meta price differs by at most
      // ~5% — if it's wildly different, something is wrong (a
      // corporate action, a symbol collision, a stale meta block)
      // and we'd rather log and keep the raw close.
      const drift = Math.abs((rmp - last.close) / last.close);
      if (drift < 0.05) {
        last.close = rmp;
      }
    }
  }

  return { ok: true, source: 'yahoo', candles };
}

export async function fetchYahooCandles(
  symbol: string,
  opts:   YahooCandleOpts = {},
): Promise<CandleFetchResult> {
  const range    = opts.range    ?? '1y';
  const interval = opts.interval ?? '1d';

  const first = await fetchOnce('query1.finance.yahoo.com', symbol, range, interval);
  if (first.ok) return first;

  // Retry on the sibling edge — different POP, often resolves transient
  // rate-limit / empty responses without waiting for a backoff.
  const retry = await fetchOnce('query2.finance.yahoo.com', symbol, range, interval);
  return retry;
}
