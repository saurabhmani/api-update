// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/bot
//
//  Yahoo-only live-quote polling endpoint for the stock detail bot. // @deprecated marker
//  Per symbol returns:
//    { symbol, price, change, pChange, close, source, status, lastUpdated }
//
//  Status classification post-Kite-removal: // @deprecated marker
//    DELAYED  — Yahoo snapshot, market OPEN (15-min delayed) // @deprecated marker
//    CLOSED   — Yahoo returned yesterday's close, market CLOSED // @deprecated marker
//    OFFLINE  — Yahoo returned nothing for this symbol // @deprecated marker
//
//  Usage (public, no auth):
//    GET /api/market-data/bot?symbols=RELIANCE,TCS,INFY
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { fetchYahooQuotesBatch, type YahooBatchQuote } from '@/lib/marketData/yahooBatch'; // @deprecated marker
import { isMarketOpen } from '@/lib/marketData/marketHours';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export type BotStatus = 'LIVE' | 'STALE' | 'DELAYED' | 'CLOSED' | 'OFFLINE';
export type BotSource = 'yahoo' | 'none'; // @deprecated marker

export interface StockBotEntry {
  symbol:      string;
  price:       number | null;
  change:      number | null;
  pChange:     number | null;
  close:       number | null;
  source:      BotSource;
  status:      BotStatus;
  lastUpdated: number;
  ageMs:       number | null;
}

function classify(
  symbol: string,
  marketOpen: boolean,
  yahooMap: Map<string, YahooBatchQuote>, // @deprecated marker
): StockBotEntry {
  const sym = symbol.trim().toUpperCase();
  const y = yahooMap.get(sym); // @deprecated marker
  if (y && y.price != null && y.price > 0) {
    return {
      symbol:      sym,
      price:       y.price,
      change:      y.change,
      pChange:     y.pChange,
      close:       y.previousClose,
      source:      'yahoo', // @deprecated marker
      status:      marketOpen ? 'DELAYED' : 'CLOSED',
      lastUpdated: y.marketTime ?? Date.now(),
      ageMs:       y.marketTime ? Date.now() - y.marketTime : 0,
    };
  }
  return {
    symbol: sym,
    price: null,
    change: null,
    pChange: null,
    close: null,
    source: 'none',
    status: 'OFFLINE',
    lastUpdated: Date.now(),
    ageMs: null,
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const raw = sp.get('symbols');

  let symbols: string[] = [];
  if (raw) {
    symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  if (symbols.length === 0) {
    return NextResponse.json(
      { error: 'symbols param required (e.g. ?symbols=RELIANCE,TCS)' },
      { status: 400 },
    );
  }
  symbols = [...new Set(symbols)].slice(0, 200);

  const marketOpen = isMarketOpen();
  const started = Date.now();
  const yahooMap = await fetchYahooQuotesBatch(symbols); // @deprecated marker

  const entries: StockBotEntry[] = symbols.map(
    (s) => classify(s, marketOpen, yahooMap), // @deprecated marker
  );

  const counts = {
    LIVE:    0,
    CLOSED:  entries.filter((e) => e.status === 'CLOSED').length,
    STALE:   0,
    DELAYED: entries.filter((e) => e.status === 'DELAYED').length,
    OFFLINE: entries.filter((e) => e.status === 'OFFLINE').length,
  };
  const overall: BotStatus =
    counts.OFFLINE === entries.length ? 'OFFLINE' :
    counts.DELAYED >  0               ? 'DELAYED' :
    counts.CLOSED  >  0               ? 'CLOSED'  : 'OFFLINE';

  return NextResponse.json(
    {
      overall,
      counts,
      marketOpen,
      yahooCalls:    symbols.length, // @deprecated marker
      yahooReturned: yahooMap.size, // @deprecated marker
      elapsedMs:     Date.now() - started,
      entries,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
