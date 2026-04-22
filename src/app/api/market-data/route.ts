/**
 * GET /api/market-data?action=snapshot&symbol=RELIANCE
 * GET /api/market-data?action=batch&symbols=RELIANCE,TCS,INFY
 * GET /api/market-data?action=status
 * GET /api/market-data?action=options&symbol=NIFTY
 * GET /api/market-data?action=candles&symbol=NSE_EQ|INE002A01018&interval=1minute
 * POST /api/market-data  { action: 'refresh', symbol: 'RELIANCE' }  (admin)
 * POST /api/market-data  { action: 'refresh-all' }                   (admin)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import {
  getSnapshot,
  getSnapshotSync,
  getMultipleSnapshots,
  getOptionChain,
  refreshMarketUniverse,
  forceRefresh,
  getAggregatorStatus,
} from '@/services/dataAggregator';
import { getHistoricalCandles } from '@/services/marketDataService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const action   = searchParams.get('action') || 'snapshot';
  const symbol   = searchParams.get('symbol')?.trim().toUpperCase() ?? '';
  const symbolsP = searchParams.get('symbols') ?? '';
  const interval = searchParams.get('interval') ?? '1minute';
  const limit    = Math.min(parseInt(searchParams.get('limit') ?? '200'), 1000);

  // ── Single snapshot ──────────────────────────────────────────
  if (action === 'snapshot') {
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const snap = await getSnapshot(symbol);
    if (!snap) return NextResponse.json({
      snapshot: null,
      note: 'Data not yet cached. Trigger a universe refresh in Admin panel.',
    });
    return NextResponse.json({ snapshot: snap });
  }

  // ── Batch snapshots (comma-separated symbols) ────────────────
  if (action === 'batch') {
    const syms = symbolsP.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!syms.length) return NextResponse.json({ error: 'symbols required' }, { status: 400 });
    const snaps = await getMultipleSnapshots(syms);
    return NextResponse.json({ snapshots: snaps, count: Object.keys(snaps).length });
  }

  // ── Option chain ─────────────────────────────────────────────
  if (action === 'options') {
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const chain = await getOptionChain(symbol);
    if (!chain)  return NextResponse.json({ chain: null, note: 'Option data unavailable — market may be closed.' });
    return NextResponse.json({ chain });
  }

  // ── Historical candles from MySQL ────────────────────────────
  if (action === 'candles') {
    if (!symbol) return NextResponse.json({ error: 'symbol (instrument_key) required' }, { status: 400 });
    const candles = await getHistoricalCandles(symbol, interval, limit);
    return NextResponse.json({ candles, count: candles.length, instrument_key: symbol, interval });
  }

  // ── Aggregator status (admin) ────────────────────────────────
  if (action === 'status') {
    const status = getAggregatorStatus();
    return NextResponse.json({ status });
  }

  return NextResponse.json({ error: 'Invalid action. Use: snapshot, batch, options, candles, status' }, { status: 400 });
}

export async function POST(req: NextRequest) {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  const { action, symbol, instrument_key, limit } = await req.json().catch(() => ({}));

  // ── Force refresh single symbol ──────────────────────────────
  if (action === 'refresh' && symbol) {
    const snap = await forceRefresh(symbol, instrument_key ?? '');
    return NextResponse.json({ success: !!snap, snapshot: snap });
  }

  // ── Refresh full universe ────────────────────────────────────
  if (action === 'refresh-all') {
    const result = await refreshMarketUniverse(limit ?? 100);
    return NextResponse.json({ success: true, ...result });
  }

  return NextResponse.json({ error: 'Invalid action. Use: refresh, refresh-all' }, { status: 400 });
}
