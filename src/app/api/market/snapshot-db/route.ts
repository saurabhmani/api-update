// ════════════════════════════════════════════════════════════════
//  GET /api/market/snapshot-db?symbol=RELIANCE
//
//  PURE PostgreSQL read — no vendor call, no MarketDataProvider
//  fallback chain. Returns the last snapshot persisted by the
//  scheduler in market.snapshots_current.
//
//  Exists mainly for migration validation: the parallel MySQL route
//  should return the same numbers within tolerance. Once cutover
//  lands, the regular /api/market/quote route will read here as its
//  DB fallback.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getSnapshot } from '@/services/repos/snapshotRepo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });

  try {
    const snap = await getSnapshot(symbol);
    if (!snap) {
      return NextResponse.json(
        { error: 'no snapshot in postgres for symbol', symbol },
        { status: 404, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(
      { data: snap, source: 'db', data_quality: 'stale', fetched_at: Date.now() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    );
  }
}
