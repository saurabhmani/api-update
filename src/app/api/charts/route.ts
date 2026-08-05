/**
 * GET /api/charts
 *
 * Session required. Candles from IndianAPI warehouse (DB/cache).
 * No broker fill — empty warehouse means ingestion has not completed yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getChartData, type ChartInterval } from '@/services/chartService';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  isMarketApiGateResponse,
  labelCandleDataOrigin,
  providerDataJson,
  resolveOptionalUserMarketMeta,
} from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VALID_INTERVALS = new Set<ChartInterval>([
  '1minute', '5minute', '15minute', '30minute', '60minute',
  '1day', '1week', '1month',
]);

const INTRADAY_BUCKET = new Set<ChartInterval>([
  '1minute', '5minute', '15minute', '30minute', '60minute',
]);

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw err;
  }

  const { searchParams } = req.nextUrl;
  const instrumentKey = searchParams.get('instrumentKey') ?? '';
  const rawSymbol = searchParams.get('symbol')?.toUpperCase()
    ?? instrumentKey.split('|')[1]?.toUpperCase()
    ?? instrumentKey.toUpperCase();

  if (!rawSymbol) {
    return NextResponse.json(
      { error: 'symbol or instrumentKey required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const type = searchParams.get('type') ?? 'historical';
  const rawInterval = searchParams.get('interval') ?? (type === 'intraday' ? '1minute' : '1day');
  const interval: ChartInterval = VALID_INTERVALS.has(rawInterval as ChartInterval)
    ? rawInterval as ChartInterval
    : type === 'intraday' ? '1minute' : '1day';

  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const isIntraday = type === 'intraday' || (INTRADAY_BUCKET.has(interval) && interval !== '1day');
  const defaultLimit = interval === '1day' ? 120 : isIntraday ? 500 : 200;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? String(defaultLimit), 10) || defaultLimit, 1000);

  const warehouse = await getChartData(rawSymbol, interval, from, to, limit);

  const meta = await resolveOptionalUserMarketMeta();
  const metaOk = !isMarketApiGateResponse(meta);
  const providerName = metaOk ? meta.provider : 'indianapi';
  const status = metaOk ? meta.status : 'indianapi_ready';
  const origin = labelCandleDataOrigin(warehouse.source);

  return providerDataJson(
    providerName,
    status,
    {
      candles: warehouse.candles,
      instrument_key: warehouse.instrument_key,
      symbol: warehouse.symbol,
      interval,
      count: warehouse.candles.length,
      source: warehouse.source,
      cached: warehouse.cached,
      note: warehouse.candles.length === 0
        ? 'No candle data in IndianAPI warehouse yet. Wait for daily candle ingestion / scans.'
        : undefined,
      unsupported: isIntraday && warehouse.candles.length === 0
        ? 'Intraday candles may be unsupported until IndianAPI ingest covers that interval'
        : undefined,
    },
    {
      dataOrigin: origin.dataOrigin,
      fallbackUsed: origin.fallbackUsed,
      fallbackSource: origin.fallbackSource,
    },
  );
}
