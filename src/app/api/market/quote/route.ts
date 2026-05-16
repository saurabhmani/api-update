// ════════════════════════════════════════════════════════════════
//  GET /api/market/quote?symbol=RELIANCE
//
//  Thin HTTP wrapper over MarketDataProvider.getLiveSnapshot.
//  No vendor logic, no caching, no fallback decisions — all of that
//  lives in the provider. The route's only jobs are argument parsing,
//  error mapping, and response envelope.
//
//  Query params:
//    symbol          — required, e.g. "RELIANCE"
//    signalCritical  — optional "1" to reject stale/DB responses
//    forceRefresh    — optional "1" to bypass in-memory cache
//
//  Response:
//    { data, source, data_quality, fetched_at, trail? }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import MarketDataProvider from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';
import { logger } from '@/lib/logger';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';

const log = logger.child({ route: '/api/market/quote' });

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const symbol = req.nextUrl.searchParams.get('symbol');
  const signalCritical = req.nextUrl.searchParams.get('signalCritical') === '1';
  const forceRefresh = req.nextUrl.searchParams.get('forceRefresh') === '1';

  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol query param is required' },
      { status: 400 },
    );
  }

  // Universe init guard — MarketDataProvider transits the resolver which
  // calls isInNifty500() (sync getter; throws if cache isn't hydrated).
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      { error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error },
      { status: 503 },
    );
  }

  try {
    const resp = await MarketDataProvider.getLiveSnapshot(symbol, { signalCritical, forceRefresh });
    return NextResponse.json(resp, {
      status: 200,
      headers: {
        // Browser caching is handled by the provider's in-memory layer —
        // we don't want CDN/browser overriding the quality labels.
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof StaleDataError) {
      return NextResponse.json(
        { error: err.message, response: err.response },
        { status: 503 },
      );
    }
    log.error('quote route error', {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'internal error fetching quote' },
      { status: 500 },
    );
  }
}
