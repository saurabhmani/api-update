// ════════════════════════════════════════════════════════════════
//  GET /api/stocks
//
//  Post-Kite-removal, there is no WebSocket-fed tick store to
//  enumerate. The two supported shapes are:
//
//    • GET /api/stocks?symbol=RELIANCE
//        → single-symbol Yahoo-backed price lookup
//
//    • GET /api/stocks (no param)
//        → empty list (the "full WS universe" shape has no meaning
//          without a live tick bus). Returns count: 0 rather than
//          500 so existing callers don't crash.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getLivePrice } from '@/lib/marketData/getLivePrice';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const symbolParam = req.nextUrl.searchParams.get('symbol')?.trim();
  if (symbolParam) {
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

  return NextResponse.json(
    { stocks: [], count: 0 },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
