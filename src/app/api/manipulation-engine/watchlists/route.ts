// ════════════════════════════════════════════════════════════════
//  GET  /api/manipulation-engine/watchlists?type=
//  POST /api/manipulation-engine/watchlists  body: { symbol, action }
//
//  Phase 3 — read current watchlists or run the evaluator manually.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import {
  ensureManipulationEngineTables,
  loadAllWatchlists,
  loadWatchlist,
  loadWatchlistHistory,
  evaluateWatchlists,
  diffWatchlistState,
  applyWatchlistChanges,
  loadWatchlistForSymbol,
  loadLatestSnapshot,
} from '@/lib/manipulation-engine';
import type { WatchlistType } from '@/lib/manipulation-engine';

export async function GET(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const type = req.nextUrl.searchParams.get('type') as WatchlistType | null;
    const symbol = req.nextUrl.searchParams.get('symbol');
    const includeHistory = req.nextUrl.searchParams.get('history') === '1';

    const data: any = {};
    if (type) {
      data.watchlist = await loadWatchlist(type);
    } else {
      data.watchlists = await loadAllWatchlists();
    }
    if (includeHistory) {
      data.history = await loadWatchlistHistory(symbol ?? undefined, type ?? undefined, 100);
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureManipulationEngineTables();
    const body = await req.json();
    const symbol = String(body.symbol ?? '');
    if (!symbol) {
      return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    }
    const snapshot = await loadLatestSnapshot(symbol);
    if (!snapshot) {
      return NextResponse.json({ error: 'no snapshot for symbol', symbol }, { status: 404 });
    }
    const decisions = evaluateWatchlists(snapshot);
    const current = await loadWatchlistForSymbol(symbol);
    const changes = diffWatchlistState(snapshot, decisions, current);
    await applyWatchlistChanges(changes);
    return NextResponse.json({ symbol, decisions, changes });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
