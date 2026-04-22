// ════════════════════════════════════════════════════════════════
//  GET /api/stocks
//
//  Returns the full universe of live stocks from the in-process
//  WebSocket-fed tick store. No DB, no REST upstream — every row
//  is a frame that originated on the Kite WebSocket, mirrored into
//  the TickStore Map.
//
//  Shape:
//    {
//      stocks: Array<{ symbol, price, timestamp, volume?, change? }>,
//      count:  number,
//    }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTickStore } from '@/lib/marketData/tickStore';
import type { TickData } from '@/lib/marketData/tickTypes';
import { getLivePrice } from '@/lib/marketData/getLivePrice';
import { bootTickerSafe } from '@/lib/marketData/bootTicker';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

interface StockRow {
  symbol:    string;
  price:     number;
  timestamp: number;
  volume:    number;
  change:    number | null;
}

function toRow(t: TickData): StockRow | null {
  if (!t.symbol || !t.lastPrice) return null;
  return {
    symbol:    t.symbol,
    price:     t.lastPrice,
    timestamp: t.ts,
    volume:    t.volume ?? 0,
    change:    typeof t.pChange === 'number' ? t.pChange : null,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Single-symbol mode: /api/stocks?symbol=RELIANCE ──────────
  // Delegates to getLivePrice (Kite → Yahoo). Returns a
  // normalized shape so the frontend never branches on source.
  const symbolParam = req.nextUrl.searchParams.get('symbol')?.trim();
  if (symbolParam) {
    await bootTickerSafe();
    const result = await getLivePrice(symbolParam);
    const symbol = symbolParam.toUpperCase().replace(/^(NSE|BSE):/, '');

    if (result.price == null) {
      return NextResponse.json(
        { error: 'price_unavailable', symbol, source: 'none', detail: result.error },
        { status: 503, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
      );
    }

    return NextResponse.json(
      {
        symbol,
        price:         result.price,
        change:        result.change         ?? null,
        changePercent: result.pChange        ?? null,
        volume:        result.volume         ?? null,
        source:        result.source,
      },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }

  const store = getTickStore();
  store.install(); // idempotent — ensures bus listener is wired

  const snapshot: TickData[] = store.snapshot();
  const stocks: StockRow[] = [];
  for (const t of snapshot) {
    const row = toRow(t);
    if (row) stocks.push(row);
  }

  // Deterministic order — alphabetic by symbol so the UI list is
  // stable across polls. Cheap: 2k entries.
  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));

  console.log(`[STOCKS API] Total stocks: ${stocks.length}`);

  return NextResponse.json(
    { stocks, count: stocks.length },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
