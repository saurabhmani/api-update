// ════════════════════════════════════════════════════════════════
//  GET /api/price?symbol=TITAN
//
//  Yahoo-only price endpoint. Kite has been removed from the system.
//  The response preserves the legacy shape (source / ws / kiteActive)
//  so existing callers keep working, but every field now reports the
//  Yahoo-only world: source='yahoo' on success, source='none' on
//  failure, ws='removed', kiteActive=false.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getLivePrice } from '@/lib/marketData/getLivePrice';

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

  const result = await getLivePrice(symbol);

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
    { ...result, ws: 'removed', kiteActive: false },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
