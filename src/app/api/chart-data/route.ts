/**
 * GET /api/chart-data
 *
 * Session required. Candles from IndianAPI warehouse only.
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
  const rawSymbol = searchParams.get('symbol')?.trim().toUpperCase() ?? '';
  const rawInterval = (searchParams.get('interval') ?? '1day') as ChartInterval;
  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const rawLimit = parseInt(searchParams.get('limit') ?? '100', 10);

  if (!rawSymbol) {
    return NextResponse.json(
      { error: 'symbol is required', example: '/api/chart-data?symbol=RELIANCE' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const symbol = rawSymbol.replace(/^(NSE|BSE):/, '');
  const interval = VALID_INTERVALS.has(rawInterval) ? rawInterval : '1day';
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;

  if (from && isNaN(Date.parse(from))) {
    return NextResponse.json({ error: `Invalid 'from' date: ${from}` }, { status: 400 });
  }
  if (to && isNaN(Date.parse(to))) {
    return NextResponse.json({ error: `Invalid 'to' date: ${to}` }, { status: 400 });
  }

  try {
    const warehouse = await getChartData(symbol, interval, from, to, limit);
    const meta = await resolveOptionalUserMarketMeta();
    const metaOk = !isMarketApiGateResponse(meta);
    const providerName = metaOk ? meta.provider : 'indianapi';
    const status = metaOk ? meta.status : 'indianapi_ready';
    const origin = labelCandleDataOrigin(warehouse.source);

    return providerDataJson(
      providerName,
      status,
      {
        symbol: warehouse.symbol,
        instrument_key: warehouse.instrument_key,
        interval,
        from: warehouse.from,
        to: warehouse.to,
        candles: warehouse.candles,
        count: warehouse.candles.length,
        source: warehouse.source,
        cached: warehouse.cached,
        ...(warehouse.candles.length === 0
          ? {
              note: 'No candle data in IndianAPI warehouse yet. Populated by scheduled candle ingestion.',
            }
          : {}),
      },
      {
        dataOrigin: origin.dataOrigin,
        fallbackUsed: origin.fallbackUsed,
        fallbackSource: origin.fallbackSource,
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[/api/chart-data] ${symbol}:`, message);
    return NextResponse.json(
      { error: 'Failed to fetch chart data', details: message },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
