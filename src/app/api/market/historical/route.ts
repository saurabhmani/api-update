import { NextRequest, NextResponse } from 'next/server';
import MarketDataProvider from '@/providers/MarketDataProvider';
import type { HistoricalRange } from '@/types/market';
import { StaleDataError } from '@/types/market';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VALID_RANGES: HistoricalRange[] = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'];

export async function GET(req: NextRequest): Promise<Response> {
  const symbol = req.nextUrl.searchParams.get('symbol');
  const range = (req.nextUrl.searchParams.get('range') ?? '1mo') as HistoricalRange;
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  if (!VALID_RANGES.includes(range)) {
    return NextResponse.json({ error: `invalid range, one of: ${VALID_RANGES.join(',')}` }, { status: 400 });
  }
  // Universe init guard — MarketDataProvider hits the resolver which calls
  // isInNifty500() (sync getter that throws if cache isn't hydrated).
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      { error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error },
      { status: 503 },
    );
  }
  try {
    const resp = await MarketDataProvider.getHistorical(symbol, range);
    return NextResponse.json(resp, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof StaleDataError) return NextResponse.json({ error: err.message }, { status: 503 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'internal error' }, { status: 500 });
  }
}
