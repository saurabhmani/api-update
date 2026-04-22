// ════════════════════════════════════════════════════════════════
//  GET /api/price?symbol=TITAN
//
//  STRICT PRIMARY-FALLBACK chain:
//
//    1. Kite tick cache (real-time)
//    2. Yahoo Finance (15-min fallback)
//
//  The fallback chain is driven entirely by `getLivePrice()` in
//  src/lib/marketData/getLivePrice.ts. This route is a thin HTTP
//  wrapper — parse query param, call getLivePrice, shape the
//  response. No data-flow logic lives here.
//
//  The `source` field in the response tells the caller which
//  layer served the data: 'kite' | 'yahoo' | 'none'.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getLivePrice, isKiteActive } from '@/lib/marketData/getLivePrice';
import { bootTickerSafe } from '@/lib/marketData/bootTicker';
import { getTicker } from '@/lib/marketData/kiteTicker';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get('symbol')?.trim();

  if (!symbol) {
    return NextResponse.json(
      { price: null, source: 'none', error: 'symbol query param required' },
      { status: 400 },
    );
  }

  // Lazy boot so a fresh server with no instrumentation-time token
  // still converges to a working state on first hit.
  await bootTickerSafe();

  const result = await getLivePrice(symbol);

  const tickerStatus = getTicker().getStatus();
  const kiteActive = isKiteActive(symbol);

  // Match the strict contract from the spec:
  //   success  → 200 with {price, change, pChange, source}
  //   all fail → 503 with {error:'price_unavailable', source:'none'}
  if (result.price == null) {
    return NextResponse.json(
      { error: 'price_unavailable', source: 'none', detail: result.error },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      },
    );
  }

  return NextResponse.json(
    { ...result, ws: tickerStatus.state, kiteActive },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
