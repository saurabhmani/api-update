// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/bot
//
//  Smart data-quality bot. For each requested symbol, returns:
//    { symbol, price, change, pChange, close, source, status, lastUpdated }
//
//  Status classification (per spec):
//    LIVE     — Kite tick in last 3 s AND market is open
//    STALE    — Kite tick exists but older (cached last close, market shut)
//    DELAYED  — Yahoo snapshot (15-min delayed fallback)
//    OFFLINE  — no data anywhere
//
//  Reuses existing infrastructure: kiteTicker's in-memory cache for
//  Kite, fetchFromYahooCached for the Yahoo fallback with 2s TTL +
//  in-flight dedup.
//
//  Usage (public, no auth):
//    GET /api/market-data/bot?symbols=RELIANCE,TCS,INFY
//    GET /api/market-data/bot?all=1    → auto-uses subscribed universe
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTicker } from '@/lib/marketData/kiteTicker';
import { fetchYahooQuotesBatch, type YahooBatchQuote } from '@/lib/marketData/yahooBatch';
import { isMarketOpen } from '@/lib/marketData/marketHours';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const FRESH_MS = Number(process.env.MAX_KITE_AGE_MS) || 3_000;

export type BotStatus = 'LIVE' | 'STALE' | 'DELAYED' | 'CLOSED' | 'OFFLINE';
export type BotSource = 'kite' | 'yahoo' | 'none';

export interface StockBotEntry {
  symbol:      string;
  price:       number | null;
  change:      number | null;
  pChange:     number | null;
  close:       number | null;     // previous-day close for change calc
  source:      BotSource;
  status:      BotStatus;
  lastUpdated: number;            // ms epoch of the tick / fetch
  ageMs:       number | null;
}

/**
 * Per-symbol classifier. IMPORTANT: this function never calls Yahoo
 * itself — Yahoo is fetched ONCE in a batch at the caller level, so
 * we never spam Yahoo per-symbol per-second.
 */
function classify(
  symbol: string,
  marketOpen: boolean,
  yahooMap: Map<string, YahooBatchQuote>,
): StockBotEntry {
  const sym = symbol.trim().toUpperCase();
  const ticker = getTicker();
  const tick = ticker.getTickBySymbolSync(sym);

  // ── STEP 1 — Check Kite ──────────────────────────────────────
  if (tick && tick.lastPrice != null && tick.lastPrice > 0) {
    const age = Date.now() - (tick.ts ?? 0);

    // MARKET OPEN + fresh tick → LIVE
    if (marketOpen && age < FRESH_MS) {
      return {
        symbol: sym,
        price: tick.lastPrice,
        change: tick.change ?? null,
        pChange: tick.pChange ?? null,
        close: tick.close ?? null,
        source: 'kite',
        status: 'LIVE',
        lastUpdated: tick.ts,
        ageMs: age,
      };
    }

    // MARKET CLOSED + any cached tick → CLOSED (last-traded price)
    if (!marketOpen) {
      return {
        symbol: sym,
        price: tick.lastPrice,
        change: tick.change ?? null,
        pChange: tick.pChange ?? null,
        close: tick.close ?? null,
        source: 'kite',
        status: 'CLOSED',
        lastUpdated: tick.ts,
        ageMs: age,
      };
    }

    // MARKET OPEN + stale Kite (>FRESH_MS): fall through to Yahoo.
    // This is the "switching" branch — we'll auto-switch back to Kite
    // the moment a fresh tick lands in the ticker cache.
  }

  // ── STEP 2 — Use Yahoo batch (already fetched) ──────────────
  const y = yahooMap.get(sym);
  if (y && y.price != null && y.price > 0) {
    return {
      symbol:      sym,
      price:       y.price,
      change:      y.change,
      pChange:     y.pChange,
      close:       y.previousClose,
      source:      'yahoo',
      status:      marketOpen ? 'DELAYED' : 'DELAYED',
      lastUpdated: y.marketTime ?? Date.now(),
      ageMs:       y.marketTime ? Date.now() - y.marketTime : 0,
    };
  }

  // ── OFFLINE: both upstreams dry ─────────────────────────────
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
  const all = sp.get('all') === '1';

  let symbols: string[] = [];
  if (raw) {
    symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else if (all) {
    symbols = await getTicker().listSubscribedSymbols();
  }
  if (symbols.length === 0) {
    return NextResponse.json(
      { error: 'symbols param required (e.g. ?symbols=RELIANCE,TCS) or ?all=1' },
      { status: 400 },
    );
  }
  // Cap to protect upstreams — Yahoo gets hammered if someone asks for 3k at once.
  symbols = [...new Set(symbols)].slice(0, 200);

  const marketOpen = isMarketOpen();
  const started = Date.now();
  const ticker = getTicker();

  // First pass: decide which symbols need a Yahoo fetch.
  //
  // Per spec — don't call Yahoo when Kite is LIVE. A symbol needs
  // Yahoo only when it has no fresh Kite tick (or no Kite tick at
  // all). This keeps the fallback narrow — only the symbols that
  // actually need it round-trip to Yahoo.
  const needsYahoo: string[] = [];
  for (const sym of symbols) {
    const tick = ticker.getTickBySymbolSync(sym);
    const hasFresh = tick && tick.lastPrice != null && tick.lastPrice > 0
      && marketOpen && (Date.now() - (tick.ts ?? 0)) < FRESH_MS;
    const hasCachedClosed = tick && tick.lastPrice != null && tick.lastPrice > 0
      && !marketOpen;
    if (!hasFresh && !hasCachedClosed) needsYahoo.push(sym);
  }

  // Single batched Yahoo call for ALL stale-Kite symbols.
  const yahooMap = needsYahoo.length > 0
    ? await fetchYahooQuotesBatch(needsYahoo)
    : new Map<string, YahooBatchQuote>();

  const entries: StockBotEntry[] = symbols.map(
    (s) => classify(s, marketOpen, yahooMap),
  );

  const counts = {
    LIVE:    entries.filter((e) => e.status === 'LIVE').length,
    CLOSED:  entries.filter((e) => e.status === 'CLOSED').length,
    STALE:   entries.filter((e) => e.status === 'STALE').length,
    DELAYED: entries.filter((e) => e.status === 'DELAYED').length,
    OFFLINE: entries.filter((e) => e.status === 'OFFLINE').length,
  };
  // Single system-wide status drives the bot icon in the header.
  const overall: BotStatus =
    counts.OFFLINE === entries.length ? 'OFFLINE' :
    counts.LIVE    >  0               ? 'LIVE'    :
    counts.CLOSED  >= counts.DELAYED  ? 'CLOSED'  : 'DELAYED';

  return NextResponse.json(
    {
      overall,
      counts,
      marketOpen,
      yahooCalls:    needsYahoo.length,
      yahooReturned: yahooMap.size,
      elapsedMs:     Date.now() - started,
      entries,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
