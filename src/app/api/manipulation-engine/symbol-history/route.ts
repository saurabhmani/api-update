// ════════════════════════════════════════════════════════════════
//  GET /api/manipulation-engine/symbol-history?symbol=TCS&days=120
//
//  Phase 3 — full surveillance history for one symbol: snapshot
//  trend, raw events, watchlist membership, watchlist history.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables,
  loadSnapshotsForSymbol,
  loadEvents,
  loadWatchlistForSymbol,
  loadWatchlistHistory,
} from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const symbol = req.nextUrl.searchParams.get('symbol');
    const days = Number(req.nextUrl.searchParams.get('days') ?? 120);
    if (!symbol) {
      return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    }
    const end = new Date();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - Math.max(1, Math.min(days, 365)));
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];

    const [snapshots, events, watchlist, history] = await Promise.all([
      loadSnapshotsForSymbol(symbol, startStr, endStr),
      loadEvents({ symbol, startDate: startStr, endDate: endStr, limit: 500 }),
      loadWatchlistForSymbol(symbol),
      loadWatchlistHistory(symbol, undefined, 100),
    ]);

    return NextResponse.json({
      symbol,
      windowDays: days,
      snapshots,
      events,
      watchlist,
      watchlistHistory: history,
      penaltiesNote: 'use /api/manipulation-engine/penalties?signalId= for per-signal detail',
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
