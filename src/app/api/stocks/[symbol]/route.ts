/**
 * GET /api/stocks/[symbol]
 *
 * Returns full stock detail for one equity symbol.
 *
 * Query params:
 *   interval — candle interval: 1minute | 5minute | 15minute | 1day
 *              (default: 1minute)
 *   limit    — number of candles: 1–500 (default: 100)
 *
 * Examples:
 *   /api/stocks/RELIANCE
 *   /api/stocks/HDFCBANK?interval=5minute&limit=200
 *   /api/stocks/NIFTY%2050?interval=1day&limit=365
 *
 * Response shape:
 * {
 *   symbol, instrument_key, name,
 *   ltp, open, day_high, day_low, prev_close,
 *   change_abs, change_percent, volume, vwap,
 *   week52_high, week52_low,
 *   candles: [{ ts, open, high, low, close, volume, oi }],
 *   candle_interval,
 *   score, rank_position,
 *   signal_type, confidence, signal_strength,
 *   entry_price, stop_loss, target1, target2, risk_reward,
 *   reasons: [{ rank, factor_key, text }],
 *   signal_age_min,
 *   data_source, as_of
 * }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { getStockDetail }            from '@/services/stockDetailService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

const VALID_INTERVALS = new Set(['1minute','5minute','15minute','30minute','60minute','1day']);

export async function GET(
  req:     NextRequest,
  context: { params: { symbol: string } }
) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // ── Params ────────────────────────────────────────────────────
  const rawSymbol  = decodeURIComponent(context.params.symbol ?? '').trim().toUpperCase();
  const rawInterval = req.nextUrl.searchParams.get('interval') ?? '1minute';
  const rawLimit    = parseInt(req.nextUrl.searchParams.get('limit') ?? '100', 10);

  if (!rawSymbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
  }
  // Strip any accidental exchange prefix (NSE: or BSE:)
  const symbol   = rawSymbol.replace(/^(NSE|BSE):/, '');
  const interval = VALID_INTERVALS.has(rawInterval) ? rawInterval : '1minute';
  const limit    = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;

  try {
    const detail = await getStockDetail(symbol, interval, limit);

    if (!detail) {
      return NextResponse.json(
        {
          error:  'No data found for symbol',
          symbol,
          hint:   'Run Admin → Data → Sync Rankings to populate market data. ' +
                  'Candles are populated by the scheduler after market hours.',
        },
        { status: 404 }
      );
    }

    return NextResponse.json(detail);

  } catch (err: any) {
    console.error(`[/api/stocks/${symbol}] Error:`, err?.message);
    return NextResponse.json(
      { error: 'Failed to fetch stock detail', details: err?.message },
      { status: 500 }
    );
  }
}
