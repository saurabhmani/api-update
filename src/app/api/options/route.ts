/**
 * GET /api/options
 *
 * Returns option chain data. Falls back to 503 when upstream is unavailable.
 */
import { NextRequest, NextResponse }       from 'next/server';
import { requireSession }                  from '@/lib/session';
import { getOptionChainSnapshot }          from '@/services/marketDataService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const symbol = searchParams.get('symbol')?.toUpperCase();

  if (!symbol) {
    return NextResponse.json(
      { error: 'symbol required', example: '/api/options?symbol=NIFTY' },
      { status: 400 }
    );
  }

  const chain = await getOptionChainSnapshot(symbol);

  if (!chain) {
    return NextResponse.json(
      { error: `Option chain unavailable for ${symbol}. Market may be closed or symbol unsupported.` },
      { status: 503 }
    );
  }

  return NextResponse.json({
    symbol:           chain.symbol,
    underlying_value: chain.underlying_value,
    expiry_dates:     chain.expiry_dates,
    records:          chain.records,
    timestamp:        chain.timestamp,
    source:           chain.source ?? 'live',
  });
}
