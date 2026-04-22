// ════════════════════════════════════════════════════════════════
//  GET /api/kite/ticks                    — full snapshot of cache
//  GET /api/kite/ticks?symbol=TITAN       — single-symbol detail
//  GET /api/kite/ticks?limit=50           — cap response size
//  GET /api/kite/ticks?fresh=1            — fresh ticks only
//  GET /api/kite/ticks?sort=age           — sort=symbol|price|change|age
//  GET /api/kite/ticks?q=BANK             — filter by symbol prefix
//
//  Diagnostic endpoint — pure read from the in-memory tick cache,
//  no REST, no DB. Requires a live app session (q200_session).
//  Use this to verify that Kite ticks are flowing correctly and
//  that the numbers in the cache match what you're seeing at your
//  broker terminal.
//
//  Response shape (array mode):
//    {
//      status:  { state: 'open' | ..., subscribed, ticksCached, ... },
//      count:   1247,
//      returned: 50,
//      ticks: [
//        {
//          symbol, token, lastPrice, prevClose,
//          change, pChange, volume, open, high, low,
//          ts, ageMs, fresh
//        },
//        ...
//      ]
//    }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTicker, isFresh, type Tick } from '@/lib/marketData/kiteTicker';
import { getSession } from '@/lib/session';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

interface TickView {
  symbol:    string;
  token:     number;
  lastPrice: number;
  prevClose: number | null;
  change:    number | null;
  pChange:   number | null;
  volume:    number | null;
  open:      number | null;
  high:      number | null;
  low:       number | null;
  ts:        number;
  ageMs:     number;
  fresh:     boolean;
}

function project(tick: Tick, now: number): TickView {
  return {
    symbol:    tick.symbol ?? String(tick.token),
    token:     tick.token,
    lastPrice: tick.lastPrice,
    prevClose: tick.close ?? null,
    change:    tick.change ?? null,
    pChange:   tick.pChange ?? null,
    volume:    tick.volume ?? null,
    open:      tick.open ?? null,
    high:      tick.high ?? null,
    low:       tick.low ?? null,
    ts:        tick.ts,
    ageMs:     now - tick.ts,
    fresh:     isFresh(tick),
  };
}

export async function GET(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ticker = getTicker();
  const sp = req.nextUrl.searchParams;

  // ── Single-symbol detail mode ────────────────────────────
  const symbolParam = sp.get('symbol')?.trim();
  if (symbolParam) {
    const tick = ticker.getTickBySymbolSync(symbolParam);
    if (!tick) {
      return NextResponse.json(
        {
          error: 'no tick cached for symbol',
          symbol: symbolParam.toUpperCase(),
          status: ticker.getStatus(),
        },
        { status: 404 },
      );
    }
    return NextResponse.json({
      status: ticker.getStatus(),
      tick:   project(tick, Date.now()),
    });
  }

  // ── Bulk mode ────────────────────────────────────────────
  const now = Date.now();
  const all = ticker.getAllTicks();

  // Filters
  const freshOnly = sp.get('fresh') === '1';
  const query     = sp.get('q')?.trim().toUpperCase();
  let filtered = all;
  if (freshOnly) {
    filtered = filtered.filter((t) => isFresh(t));
  }
  if (query) {
    filtered = filtered.filter((t) =>
      (t.symbol ?? '').toUpperCase().startsWith(query),
    );
  }

  // Sort
  const sortKey = sp.get('sort') ?? 'symbol';
  const views = filtered.map((t) => project(t, now));
  switch (sortKey) {
    case 'price':
      views.sort((a, b) => b.lastPrice - a.lastPrice);
      break;
    case 'change':
      views.sort((a, b) => (b.pChange ?? 0) - (a.pChange ?? 0));
      break;
    case 'age':
      views.sort((a, b) => a.ageMs - b.ageMs);
      break;
    case 'symbol':
    default:
      views.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  // Limit (default 100 to keep responses fast)
  const rawLimit = Number(sp.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, 3000)
    : 100;
  const returned = views.slice(0, limit);

  return NextResponse.json(
    {
      status:   ticker.getStatus(),
      count:    views.length,
      returned: returned.length,
      sort:     sortKey,
      filters:  { fresh: freshOnly, q: query ?? null, limit },
      ticks:    returned,
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
