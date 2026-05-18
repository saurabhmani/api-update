/**
 * GET /api/options
 *
 * Returns option chain data. Module-resilient — returns 200 with a
 * safe-fallback payload (`chain: null`) instead of 503 so the Command
 * Center dashboard never sees "fetch failed" when upstream is offline.
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

  // MODULE-API-RESILIENCE-2026-05 — wrap upstream call; never let a
  // throw bubble out as 500. Returns 200 + `degraded:true` so the
  // dashboard renders an empty options card instead of "fetch failed".
  try {
    const chain = await getOptionChainSnapshot(symbol);
    if (!chain) {
      return NextResponse.json(
        {
          ok:       true,
          degraded: true,
          symbol,
          chain:    null,
          error:    `Option chain unavailable for ${symbol}. Market may be closed or symbol unsupported.`,
        },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
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
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[MODULE_API_FAIL]', {
      route:   '/api/options',
      stage:   'getOptionChainSnapshot',
      symbol,
      message: e.message,
      stack:   e.stack?.split('\n').slice(0, 6).join('\n'),
    });
    return NextResponse.json(
      {
        ok:       true,
        degraded: true,
        symbol,
        chain:    null,
        error:    'Options service degraded',
        details:  e.message,
      },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }
}
