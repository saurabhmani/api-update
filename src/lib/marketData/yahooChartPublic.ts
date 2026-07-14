/**
 * Public Yahoo Finance chart API — no API key required.
 * Used as a verification + fallback source when removed vendor / DB are stale.
 * NSE equities map to SYMBOL.NS tickers.
 */

import { toYahooSymbol, isPreEncodedYahoo } from '@/lib/marketData/symbolNormalize';

export interface PublicOhlcvBar {
  ts:     string;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  oi:     number;
}

export type YahooChartInterval = '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1wk';
export type YahooChartRange = '1d' | '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y';

export interface YahooPublicQuote {
  symbol:        string;
  lastPrice:     number;
  change:        number;
  pChange:       number;
  open:          number;
  dayHigh:       number;
  dayLow:        number;
  previousClose: number;
  volume:        number;
  timestamp:     number;
}

function yahooTickerForUrl(symbol: string): string {
  const sym = symbol.toUpperCase().replace(/^(NSE|BSE):/, '').split(':').pop() ?? symbol;
  const ticker = toYahooSymbol(sym);
  return isPreEncodedYahoo(ticker) ? ticker : encodeURIComponent(ticker);
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketVolume?: number;
        regularMarketTime?: number;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
}

async function fetchYahooChartRaw(
  symbol: string,
  interval: YahooChartInterval,
  range: YahooChartRange,
): Promise<YahooChartResponse | null> {
  const ticker = yahooTickerForUrl(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Quantorus365/2.1)' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await res.json() as YahooChartResponse;
  } catch {
    return null;
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Live quote + day OHLC from Yahoo chart metadata. */
export async function fetchYahooPublicQuote(symbol: string): Promise<YahooPublicQuote | null> {
  const raw = await fetchYahooChartRaw(symbol, '1d', '5d');
  const result = raw?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;

  const lastPrice = num(meta.regularMarketPrice);
  if (lastPrice <= 0) return null;

  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  const lastIdx = ts.length - 1;

  let open = lastPrice;
  let dayHigh = lastPrice;
  let dayLow = lastPrice;
  let volume = num(meta.regularMarketVolume);
  let previousClose = num(meta.chartPreviousClose ?? meta.previousClose) || lastPrice;

  if (q && lastIdx >= 0) {
    open    = num(q.open?.[lastIdx])    || open;
    dayHigh = num(q.high?.[lastIdx])    || dayHigh;
    dayLow  = num(q.low?.[lastIdx])     || dayLow;
    volume  = num(q.volume?.[lastIdx])  || volume;

    // Prefer prior trading-day close from the daily series over
    // chartPreviousClose — matches Google Finance % change better.
    if (lastIdx >= 1) {
      const priorClose = num(q.close?.[lastIdx - 1]);
      if (priorClose > 0) previousClose = priorClose;
    }
  }

  const change = lastPrice - previousClose;
  const pChange = previousClose > 0 ? (change / previousClose) * 100 : 0;

  return {
    symbol: symbol.toUpperCase(),
    lastPrice,
    change,
    pChange,
    open,
    dayHigh,
    dayLow,
    previousClose,
    volume,
    timestamp: num(meta.regularMarketTime) * 1000 || Date.now(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Batch live quotes via the public Yahoo chart API (no API key). */
export async function fetchYahooPublicQuotesBatch(
  symbolsRaw: string[],
  opts: { concurrency?: number; gapMs?: number; signal?: AbortSignal } = {},
): Promise<YahooPublicQuote[]> {
  const symbols = [...new Set(
    symbolsRaw.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean),
  )];
  if (symbols.length === 0) return [];

  const concurrency = Math.max(1, Math.min(20, opts.concurrency ?? 10));
  const gapMs = Math.max(0, opts.gapMs ?? 120);
  const out: YahooPublicQuote[] = [];

  for (let i = 0; i < symbols.length; i += concurrency) {
    if (opts.signal?.aborted) break;
    const chunk = symbols.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map((sym) => fetchYahooPublicQuote(sym)),
    );
    for (const q of results) {
      if (q && q.lastPrice > 0) out.push(q);
    }
    if (gapMs > 0 && i + concurrency < symbols.length) {
      await sleep(gapMs);
    }
  }
  return out;
}

/** OHLCV bars from Yahoo chart API. */
export async function fetchYahooPublicCandles(
  symbol: string,
  interval: YahooChartInterval,
  range: YahooChartRange,
): Promise<PublicOhlcvBar[]> {
  const raw = await fetchYahooChartRaw(symbol, interval, range);
  const result = raw?.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  if (!q || !ts.length) return [];

  const bars: PublicOhlcvBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = num(q.close?.[i]);
    if (close <= 0) continue;
    bars.push({
      ts:     new Date(ts[i]! * 1000).toISOString(),
      open:   num(q.open?.[i])  || close,
      high:   num(q.high?.[i])  || close,
      low:    num(q.low?.[i])   || close,
      close,
      volume: num(q.volume?.[i]),
      oi:     0,
    });
  }
  return bars;
}

/** 52-week high/low from Yahoo daily bars (~1y range). */
export async function fetchYahoo52WeekRange(
  symbol: string,
): Promise<{ high: number; low: number } | null> {
  const bars = await fetchYahooPublicCandles(symbol, '1d', '1y');
  if (!bars.length) return null;
  let high = 0;
  let low  = Infinity;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low > 0 && b.low < low) low = b.low;
  }
  if (high <= 0 || !Number.isFinite(low) || low <= 0) return null;
  return { high, low };
}

export function chartIntervalToYahoo(interval: string): { yahoo: YahooChartInterval; range: YahooChartRange } {
  switch (interval) {
    case '1minute':  return { yahoo: '1m',  range: '1d' };
    case '5minute':  return { yahoo: '5m',  range: '5d' };
    case '15minute': return { yahoo: '15m', range: '5d' };
    case '30minute': return { yahoo: '30m', range: '1mo' };
    case '60minute': return { yahoo: '60m', range: '1mo' };
    case '1week':    return { yahoo: '1d',  range: '1y' };
    case '1month':   return { yahoo: '1d',  range: '2y' };
    default:         return { yahoo: '1d',  range: '3mo' };
  }
}
