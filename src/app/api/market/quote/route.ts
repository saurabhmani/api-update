import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import {
  instrumentFromQuery,
  isMarketApiGateResponse,
  providerDataJson,
  resolveUserMarketDataContext,
} from '@/lib/broker/connections';
import { getLiveSnapshot } from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';

const log = logger.child({ route: '/api/market/quote' });

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/market/quote?symbol=RELIANCE
 *
 * Session → IndianAPI warehouse (cache → DB via MarketDataProvider).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const resolved = await resolveUserMarketDataContext();
  if (isMarketApiGateResponse(resolved)) return resolved;

  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol query param is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      { error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const instrument = instrumentFromQuery(symbol);
    const resp = await getLiveSnapshot(instrument.symbol);
    const snap = resp.data;
    const quote = {
      symbol: instrument.symbol,
      exchange: instrument.exchange,
      ltp: snap.ltp ?? snap.price ?? 0,
      change: snap.change ?? 0,
      changePercent: snap.changePercent ?? 0,
      volume: snap.volume ?? 0,
      open: snap.open ?? 0,
      high: snap.high ?? 0,
      low: snap.low ?? 0,
      prevClose: snap.prevClose ?? 0,
      asOfMs: snap.timestamp ?? resp.vendor_timestamp ?? resp.fetched_at,
    };

    return providerDataJson('indianapi', resolved.status, {
      symbol: instrument.symbol,
      instrumentKey: instrument.instrumentKey,
      quote,
      quotes: [quote],
      source: resp.source,
      data_quality: resp.data_quality,
    }, {
      dataOrigin: 'indianapi_warehouse',
      fallbackUsed: resp.source === 'db',
      fallbackSource: resp.source === 'db' ? 'database' : undefined,
    });
  } catch (err) {
    if (err instanceof StaleDataError) {
      return providerDataJson(
        'indianapi',
        'stale',
        {
          error: 'Quote not yet available in IndianAPI warehouse',
          code: 'warehouse_empty',
          symbol,
        },
        { status: 404 },
      );
    }
    log.error('quote route error', {
      symbol,
      userId: resolved.user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return providerDataJson(
      'indianapi',
      'error',
      { error: err instanceof Error ? err.message : String(err), code: 'quote_failed' },
      { status: 502 },
    );
  }
}
