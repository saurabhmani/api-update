import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import type { WatchlistItem } from '@/types';

export const dynamic = 'force-dynamic';

async function getOrCreateWatchlist(userId: number): Promise<number> {
  const { rows } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [userId]);
  if (rows.length) return (rows[0] as any).id;
  await db.query(`INSERT INTO watchlists (user_id, name) VALUES (?, 'Default')`, [userId]);
  const { rows: rows2 } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [userId]);
  return (rows2[0] as any).id;
}

// GET /api/watchlist
export async function GET() {
  try {
    const user = await requireSession();
    const watchlistId = await getOrCreateWatchlist(user.id);
    const { rows } = await db.query<WatchlistItem>(
      `SELECT wi.id, wi.watchlist_id, wi.instrument_key, wi.tradingsymbol, wi.exchange, wi.name, wi.added_at
       FROM watchlist_items wi WHERE wi.watchlist_id=? ORDER BY wi.added_at DESC`,
      [watchlistId]
    );
    return NextResponse.json({ items: rows, watchlist_id: watchlistId });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

    // Derive symbol/exchange/name from instrument_key if not provided
    let sym  = tradingsymbol  || instrument_key.split('|')[1] || instrument_key;
    let exch = exchange       || instrument_key.split('|')[0]?.replace('_EQ', '') || 'NSE';
    let nm   = name           || sym;

    // Try instruments table for full name
    if (!name) {
      const { rows: inst } = await db.query(
        `SELECT tradingsymbol, exchange, name FROM instruments WHERE instrument_key=? LIMIT 1`,
        [instrument_key]
      ).catch(() => ({ rows: [] }));
      if (inst.length) { sym = inst[0].tradingsymbol; exch = inst[0].exchange; nm = inst[0].name; }
    }

    // Try rankings table for name if still missing
    if (nm === sym) {
      const { rows: rank } = await db.query(
        `SELECT tradingsymbol, exchange, name FROM rankings WHERE instrument_key=? OR tradingsymbol=? LIMIT 1`,
        [instrument_key, sym]
      ).catch(() => ({ rows: [] }));
      if (rank.length && rank[0].name) {
        sym = rank[0].tradingsymbol || sym;
        exch = rank[0].exchange || exch;
        nm = rank[0].name || nm;
      }
    }

    try {
      await db.query(
        `INSERT INTO watchlist_items (watchlist_id, instrument_key, tradingsymbol, exchange, name)
         VALUES (?,?,?,?,?)`,
        [watchlistId, instrument_key, sym, exch, nm]
      );
      const { rows: newItem } = await db.query(
        `SELECT * FROM watchlist_items WHERE watchlist_id=? AND instrument_key=? LIMIT 1`,
        [watchlistId, instrument_key]
      );
      return NextResponse.json({ item: newItem[0] ?? null }, { status: 201 });
    } catch (e: any) {
      // MySQL duplicate entry
      if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) {
        return NextResponse.json({ error: 'Already in watchlist' }, { status: 409 });
      }
      throw e;
    }
  } catch (e: any) {
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('[POST /api/watchlist]', e?.message);
    return NextResponse.json({ error: 'Server error', details: e?.message }, { status: 500 });
  }
}

// DELETE /api/watchlist?id=...
export async function DELETE(req: NextRequest) {
  try {
    const user = await requireSession();
    const id   = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    await db.query(
      `DELETE wi FROM watchlist_items wi
       INNER JOIN watchlists w ON wi.watchlist_id = w.id
       WHERE wi.id=? AND w.user_id=?`,
      [id, user.id]
    );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
