import { NextRequest, NextResponse } from 'next/server';
import type { HistoricalRange } from '@/types/market';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import {
  instrumentFromQuery,
  isMarketApiGateResponse,
  providerDataJson,
  resolveUserMarketDataContext,
} from '@/lib/broker/connections';
import { getHistorical } from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_RANGES: HistoricalRange[] = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'];

/**
 * GET /api/market/historical?symbol=RELIANCE&range=1mo
 *
 * Session → IndianAPI warehouse historical (cache → DB).
 */
export async function GET(req: NextRequest): Promise<Response> {
  const resolved = await resolveUserMarketDataContext();
  if (isMarketApiGateResponse(resolved)) return resolved;

  const symbol = req.nextUrl.searchParams.get('symbol');
  const range = (req.nextUrl.searchParams.get('range') ?? '1mo') as HistoricalRange;
  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (!VALID_RANGES.includes(range)) {
    return NextResponse.json(
      { error: `invalid range, one of: ${VALID_RANGES.join(',')}` },
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
    const resp = await getHistorical(instrument.symbol, range);
    const candles = resp.data?.candles ?? [];

    return providerDataJson('indianapi', resolved.status, {
      symbol: instrument.symbol,
      instrumentKey: instrument.instrumentKey,
      range,
      interval: 'day',
      candles,
      count: candles.length,
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
          error: 'Historical series not yet available in IndianAPI warehouse',
          code: 'warehouse_empty',
          symbol,
          range,
        },
        { status: 404 },
      );
    }
    return providerDataJson(
      'indianapi',
      'error',
      { error: err instanceof Error ? err.message : String(err), code: 'historical_failed' },
      { status: 502 },
    );
  }
}
