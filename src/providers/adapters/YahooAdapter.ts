// ════════════════════════════════════════════════════════════════
//  YahooAdapter — FALLBACK source (15-min delayed for Indian equities)
//
//  Thin wrapper over the existing, battle-tested fetcher at
//  src/lib/marketData/yahoo.ts. We do NOT re-implement HTTP or
//  symbol mapping here — single source of truth for Yahoo behaviour
//  stays in that file. This adapter's job is normalization into the
//  canonical market types.
//
//  Historical candles and search go direct because the legacy
//  helper covers quote-only; both paths use the same header set and
//  timeout rules as the existing yahoo.ts.
// ════════════════════════════════════════════════════════════════

import { fetchFromYahoo } from '@/lib/marketData/yahoo';
import { logger } from '@/lib/logger';
import type {
  CorporateIntel,
  HistoricalCandle,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversResult,
  SymbolSearchHit,
} from '@/types/market';

const log = logger.child({ adapter: 'Yahoo' });

const TIMEOUT_MS = 2000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function yahooSymbol(symbol: string): string {
  const up = symbol.trim().toUpperCase();
  return up.endsWith('.NS') || up.endsWith('.BO') ? up : `${up}.NS`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: 'https://finance.yahoo.com/',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ── Quote (reuses legacy fetchFromYahoo) ────────────────────────────

export async function getQuote(symbol: string): Promise<MarketSnapshot> {
  const sym = symbol.trim().toUpperCase();
  const res = await fetchFromYahoo(sym);
  if (res.price == null) {
    throw new Error(`Yahoo returned no price for ${sym}: ${res.error ?? 'unknown'}`);
  }
  const price     = res.price;
  const prevClose = res.close ?? (price - (res.change ?? 0));
  return {
    symbol: sym,
    price,
    ltp: price,
    change:        res.change  ?? (prevClose > 0 ? price - prevClose : 0),
    changePercent: res.pChange ?? (prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0),
    volume:    res.volume ?? 0,
    open:      res.open   ?? 0,
    high:      res.high   ?? 0,
    low:       res.low    ?? 0,
    prevClose,
    timestamp: Date.now(),
  };
}

// ── Historical candles ──────────────────────────────────────────────

const RANGE_TO_YAHOO: Record<HistoricalRange, { range: string; interval: string }> = {
  '1d':  { range: '1d',  interval: '5m' },
  '5d':  { range: '5d',  interval: '15m' },
  '1mo': { range: '1mo', interval: '1d' },
  '3mo': { range: '3mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1y':  { range: '1y',  interval: '1d' },
  '5y':  { range: '5y',  interval: '1wk' },
};

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?:  (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
  };
}

export async function getHistorical(symbol: string, range: HistoricalRange): Promise<HistoricalSeries> {
  const ys = yahooSymbol(symbol);
  const { range: r, interval } = RANGE_TO_YAHOO[range];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ys)}?range=${r}&interval=${interval}`;
  const payload = await fetchJson<YahooChart>(url);
  const result = payload.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const q = result?.indicators?.quote?.[0];
  if (!q) return { symbol: symbol.toUpperCase(), range, candles: [] };

  const candles: HistoricalCandle[] = ts.map((epochSec, i) => ({
    t: epochSec * 1000,
    o: q.open?.[i]   ?? 0,
    h: q.high?.[i]   ?? 0,
    l: q.low?.[i]    ?? 0,
    c: q.close?.[i]  ?? 0,
    v: q.volume?.[i] ?? 0,
  })).filter(c => c.c > 0);

  return { symbol: symbol.toUpperCase(), range, candles };
}

// ── Symbol search ───────────────────────────────────────────────────

export async function searchSymbol(query: string): Promise<SymbolSearchHit[]> {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
  const payload = await fetchJson<{ quotes?: Array<{ symbol?: string; shortname?: string; longname?: string; exchange?: string; quoteType?: string }> }>(url);
  return (payload.quotes ?? [])
    .filter(q => q.symbol)
    .map(q => ({
      symbol: String(q.symbol).toUpperCase(),
      name: q.longname ?? q.shortname ?? q.symbol!,
      exchange: q.exchange,
      type: q.quoteType,
    }));
}

// ── Movers / Intel / Peers — unsupported on Yahoo fallback ──────────
//
// Yahoo does not expose clean equivalents for Indian-market movers,
// corporate fundamentals, or industry peers. Rather than scraping
// (fragile) we signal "not supported" — MarketDataProvider then walks
// to the DB layer if one is cached.

export async function getMovers(): Promise<MoversResult> {
  throw new Error('Yahoo adapter does not implement getMovers for Indian market');
}

export async function getCorporateIntel(_symbol: string): Promise<CorporateIntel> {
  throw new Error('Yahoo adapter does not implement getCorporateIntel');
}

export async function getIndustryPeers(_symbol: string): Promise<IndustryPeer[]> {
  throw new Error('Yahoo adapter does not implement getIndustryPeers');
}
