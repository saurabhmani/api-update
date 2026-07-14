import { NextResponse } from 'next/server';
import MarketDataProvider from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EMPTY_ENVELOPE = {
  data: { gainers: [], losers: [], mostActive: [] },
  source: 'db' as const,
  data_quality: 'stale' as const,
  fetched_at: 0,
  provider_name: 'MySQL',
  source_type: 'stale' as const,
  vendor_timestamp: 0,
  freshness_ms: 0,
  fallback_reason: null,
};

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
    // Empty movers must still be HTTP 200 — UI treats [] as "no movers today".
    if (err instanceof StaleDataError) {
      const payload = err.response ?? { ...EMPTY_ENVELOPE, fetched_at: Date.now() };
      return NextResponse.json(payload, {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    );
  }
}
