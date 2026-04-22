/**
 * GET /api/chart-data
 *
 * OHLCV candle data for charting.
 *
 * Data source priority:
 *   1. Redis cache          key: chart:{symbol}:{interval}:{from}:{to}:{limit}
 *   2. MySQL candles table  indexed on (instrument_key, interval_unit, ts)
 *   3. Yahoo Finance        public, no auth, auto-persists to MySQL
 *
 * Params:
 *   symbol    — equity tradingsymbol (required)          e.g. RELIANCE
 *   interval  — 1minute|5minute|15minute|30minute|60minute|1day|1week|1month
 *   from      — ISO date string, optional
 *   to        — ISO date string, optional
 *   limit     — max candles, 1–1000 (default 100)
 */
import { NextRequest, NextResponse }        from 'next/server';
import { requireSession }                   from '@/lib/session';
import { getChartData, type ChartInterval } from '@/services/chartService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

const VALID_INTERVALS = new Set<ChartInterval>([
  '1minute', '5minute', '15minute', '30minute', '60minute',
  '1day', '1week', '1month',
]);

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;

  const rawSymbol   = searchParams.get('symbol')?.trim().toUpperCase() ?? '';
  const rawInterval = (searchParams.get('interval') ?? '1day') as ChartInterval;
  const from        = searchParams.get('from') ?? undefined;
  const to          = searchParams.get('to')   ?? undefined;
  const rawLimit    = parseInt(searchParams.get('limit') ?? '100', 10);

  if (!rawSymbol) {
    return NextResponse.json(
      { error: 'symbol is required', example: '/api/chart-data?symbol=RELIANCE' },
      { status: 400 }
    );
  }

  const symbol   = rawSymbol.replace(/^(NSE|BSE):/, '');
  const interval = VALID_INTERVALS.has(rawInterval) ? rawInterval : '1day';
  const limit    = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 100;

  if (from && isNaN(Date.parse(from))) {
    return NextResponse.json({ error: `Invalid 'from' date: ${from}` }, { status: 400 });
  }
  if (to && isNaN(Date.parse(to))) {
    return NextResponse.json({ error: `Invalid 'to' date: ${to}` }, { status: 400 });
  }

  try {
    const result = await getChartData(symbol, interval, from, to, limit);

    if (!result.candles.length) {
      return NextResponse.json({
        symbol,
        interval,
        candles: [],
        count:   0,
        source:  result.source,
        note:    'No candle data found. Candles are populated by the scheduler each market session, or fetched from Yahoo Finance on first access.',
      });
    }

    return NextResponse.json({
      symbol:         result.symbol,
      instrument_key: result.instrument_key,
      interval:       result.interval,
      from:           result.from,
      to:             result.to,
      candles:        result.candles,
      count:          result.count,
      source:         result.source,
      cached:         result.cached,
    });
  } catch (err: any) {
    console.error(`[/api/chart-data] ${symbol}:`, err?.message);
    return NextResponse.json(
      { error: 'Failed to fetch chart data', details: err?.message },
      { status: 500 }
    );
  }
}
