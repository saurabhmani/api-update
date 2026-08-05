import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import type { WatchlistItem } from '@/types';
import {
  providerDataJson,
  resolveUserFeedMeta,
} from '@/lib/broker/connections';
import { getLiveSnapshot } from '@/providers/MarketDataProvider';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

async function getOrCreateWatchlist(userId: number): Promise<number> {
  const { rows } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [userId]);
  if (rows.length) return (rows[0] as { id: number }).id;
  await db.query(`INSERT INTO watchlists (user_id, name) VALUES (?, 'Default')`, [userId]);
  const { rows: rows2 } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [userId]);
  return (rows2[0] as { id: number }).id;
}

// GET /api/watchlist — items + optional warehouse quotes (IndianAPI)
export async function GET() {
  try {
    const user = await requireSession();
    const watchlistId = await getOrCreateWatchlist(user.id);
    const { rows } = await db.query<WatchlistItem>(
      `SELECT wi.id, wi.watchlist_id, wi.instrument_key, wi.tradingsymbol, wi.exchange, wi.name, wi.added_at
       FROM watchlist_items wi WHERE wi.watchlist_id=? ORDER BY wi.added_at DESC`,
      [watchlistId],
    );

    const feedMeta = await resolveUserFeedMeta(user.id);
    const quotes: Array<{
      symbol: string;
      instrumentKey: string;
      ltp: number | null;
      changePercent: number | null;
    }> = [];

    for (const r of rows.slice(0, 40)) {
      const sym = (r.tradingsymbol || r.instrument_key.split('|')[1] || '').toUpperCase();
      if (!sym) continue;
      try {
        const resp = await getLiveSnapshot(sym);
        quotes.push({
          symbol: sym,
          instrumentKey: r.instrument_key || `NSE_EQ|${sym}`,
          ltp: resp.data.ltp ?? resp.data.price ?? null,
          changePercent: resp.data.changePercent ?? null,
        });
      } catch {
        // Watchlist CRUD must still succeed without quotes.
      }
    }

    return providerDataJson(feedMeta.provider, feedMeta.status, {
      items: rows,
      watchlist_id: watchlistId,
      quotes,
    }, { dataOrigin: 'indianapi_warehouse' });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }
}

// POST /api/watchlist
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    const { instrument_key, tradingsymbol, exchange, name } = body;
    if (!instrument_key) return NextResponse.json({ error: 'instrument_key required' }, { status: 400 });

    const watchlistId = await getOrCreateWatchlist(user.id);

    let sym = tradingsymbol || instrument_key.split('|')[1] || instrument_key;
    let exch = exchange || instrument_key.split('|')[0]?.replace('_EQ', '') || 'NSE';
    let nm = name || sym;

    await db.query(
      `INSERT IGNORE INTO watchlist_items (watchlist_id, instrument_key, tradingsymbol, exchange, name)
       VALUES (?, ?, ?, ?, ?)`,
      [watchlistId, instrument_key, sym, exch, nm],
    );

    return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }
}

// DELETE /api/watchlist
export async function DELETE(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const id = body.id ?? body.item_id;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const watchlistId = await getOrCreateWatchlist(user.id);
    await db.query(`DELETE FROM watchlist_items WHERE id=? AND watchlist_id=?`, [id, watchlistId]);
    return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }
}
