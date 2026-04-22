import { NextResponse } from 'next/server';
import MarketDataProvider from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  try {
    const resp = await MarketDataProvider.getMovers();
    return NextResponse.json(resp, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof StaleDataError) return NextResponse.json({ error: err.message }, { status: 503 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'internal error' }, { status: 500 });
  }
}
