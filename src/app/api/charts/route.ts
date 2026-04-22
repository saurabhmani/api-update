/**
 * GET /api/charts
 *
 * Accepts either:
 *   ?symbol=RELIANCE&interval=1day
 *   ?instrumentKey=NSE_EQ|GALLANTT&type=intraday&interval=1minute   ← frontend format
 */
import { NextRequest, NextResponse }        from 'next/server';
import { requireSession }                   from '@/lib/session';
import { getChartData, type ChartInterval } from '@/services/chartService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

const VALID_INTERVALS = new Set<ChartInterval>([
  '1minute','5minute','15minute','30minute','60minute',
  '1day','1week','1month',
]);

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;

  // Support both ?symbol=X and ?instrumentKey=NSE_EQ|X
  const instrumentKey = searchParams.get('instrumentKey') ?? '';
  const rawSymbol     = searchParams.get('symbol')?.toUpperCase()
    ?? instrumentKey.split('|')[1]?.toUpperCase()
    ?? instrumentKey.toUpperCase();

  if (!rawSymbol) return NextResponse.json({ error: 'symbol or instrumentKey required' }, { status: 400 });

  // Map interval — default intraday → 1minute, historical → 1day
  const type        = searchParams.get('type') ?? 'historical';  // intraday | historical
  const rawInterval = searchParams.get('interval') ?? (type === 'intraday' ? '1minute' : '1day');

  // Normalise frontend formats like "1" (days) or "1minute"
  const interval: ChartInterval = VALID_INTERVALS.has(rawInterval as ChartInterval)
    ? rawInterval as ChartInterval
    : type === 'intraday' ? '1minute' : '1day';

  const from  = searchParams.get('from') ?? undefined;
  const to    = searchParams.get('to')   ?? undefined;
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '200'), 1000);

  const result = await getChartData(rawSymbol, interval, from, to, limit);

  return NextResponse.json({
    candles:        result.candles,
    instrument_key: result.instrument_key,
    symbol:         result.symbol,
    interval:       result.interval,
    count:          result.count,
    source:         result.source,
    cached:         result.cached,
  });
}
