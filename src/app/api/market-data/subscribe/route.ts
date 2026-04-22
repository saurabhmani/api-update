// ════════════════════════════════════════════════════════════════
//  POST /api/market-data/subscribe
//
//  Browser-driven live subscription for symbols that are NOT in the
//  q365_signals "hot universe" (stock detail pages, watchlist rows,
//  top-movers tables, …). Called by useLivePrice() on mount and on
//  a ~60s heartbeat so the view-demand TTL stays alive while the
//  component is visible.
//
//  Body (JSON):  { symbols: string[] }
//  Response:     { ok, resolved: string[], unknown: string[],
//                  subscribed: number, tickSnapshot: { [sym]: tick } }
//
//  The route does TWO things:
//    1. markViewDemand(symbols) — so dynamicSubscriptionSync keeps
//       them subscribed across its 10s reconcile cycles
//    2. ticker.subscribeSymbols(symbols) — immediate subscribe so
//       the first tick doesn't wait for the next sync
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTicker }      from '@/lib/marketData/kiteTicker';
import { bootTickerSafe } from '@/lib/marketData/bootTicker';
import { markViewDemand } from '@/lib/marketData/dynamicSubscriptionSync';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  let body: { symbols?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const raw = Array.isArray(body?.symbols) ? body.symbols : [];
  const symbols: string[] = [];
  for (const s of raw) {
    const up = String(s ?? '').trim().toUpperCase();
    if (up && !symbols.includes(up)) symbols.push(up);
  }
  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: 'no symbols' }, { status: 400 });
  }

  // Lazy boot — covers the case where the ticker hasn't started yet
  // (fresh Kite token post-deploy). Idempotent.
  await bootTickerSafe().catch(() => { /* swallow; subscribe will throw a clear error */ });

  // Extend the view-demand TTL BEFORE subscribing, so even if the
  // subscribe takes >10s (first-ever boot), the next dynSubSync cycle
  // already sees the demand and won't unsubscribe it.
  markViewDemand(symbols);

  const ticker = getTicker();
  let resolved: string[] = [];
  let unknown:  string[] = [];
  try {
    const res = await ticker.subscribeSymbols(symbols, 'quote');
    resolved = res.resolved;
    unknown  = res.unknown;
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, symbols },
      { status: 500 },
    );
  }

  // Piggyback any ticks already in the cache so the client doesn't
  // have to wait for the next wire frame if the symbol was ticking
  // for someone else.
  const tickSnapshot: Record<string, { price: number | null; ts: number | null }> = {};
  for (const s of resolved) {
    const t = ticker.getTickBySymbolSync(s);
    if (t) tickSnapshot[s] = { price: t.lastPrice ?? null, ts: t.ts ?? null };
  }

  return NextResponse.json({
    ok: true,
    resolved,
    unknown,
    subscribed: ticker.getStatus().subscribed,
    tickSnapshot,
  });
}
