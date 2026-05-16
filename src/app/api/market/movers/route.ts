import { NextResponse } from 'next/server';
import MarketDataProvider from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  // Universe init guard — MarketDataProvider transits the resolver which
  // calls isInNifty500() (sync getter; throws if cache isn't hydrated).
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      { error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error },
      { status: 503 },
    );
  }
  try {
    const resp = await MarketDataProvider.getMovers();
    return NextResponse.json(resp, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof StaleDataError) return NextResponse.json({ error: err.message }, { status: 503 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'internal error' }, { status: 500 });
  }
}
