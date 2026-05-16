import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const limit = parseInt(req.nextUrl.searchParams.get('limit') || '50');
    const { rows } = await db.query(
      `SELECT * FROM trade_journal WHERE user_id=? ORDER BY entry_date DESC LIMIT ?`,
      [user.id, limit]
    );
    return NextResponse.json({ trades: rows, count: rows.length });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    const {
      tradingsymbol, exchange, direction, entry_price, exit_price,
      quantity, entry_date, exit_date, strategy, timeframe, notes,
      emotion_entry, emotion_exit, tags,
    } = body;

    if (!tradingsymbol || !direction || !entry_price || !quantity || !entry_date) {
      return NextResponse.json({ error: 'tradingsymbol, direction, entry_price, quantity, entry_date required' }, { status: 400 });
    }

    // Compute P&L if exit provided
    let pnl: number | null = null;
    let pnl_pct: number | null = null;
    let outcome = 'open';
    if (exit_price && entry_price && quantity) {
      const exitNum  = parseFloat(exit_price);
      const entryNum = parseFloat(entry_price);
      const qtyNum   = parseInt(quantity);
      pnl     = direction === 'BUY'
        ? (exitNum - entryNum) * qtyNum
        : (entryNum - exitNum) * qtyNum;
      pnl_pct = ((pnl / (entryNum * qtyNum)) * 100);
      outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
    }

    const insert = await db.query(`
      INSERT INTO trade_journal
        (user_id, tradingsymbol, exchange, direction, entry_price, exit_price, quantity,
         entry_date, exit_date, strategy, timeframe, notes, outcome, pnl, pnl_pct,
         emotion_entry, emotion_exit, tags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [user.id, tradingsymbol.toUpperCase(), exchange || 'NSE', direction,
       parseFloat(entry_price), exit_price ? parseFloat(exit_price) : null,
       parseInt(quantity), entry_date, exit_date || null, strategy || null,
       timeframe || null, notes || null, outcome, pnl, pnl_pct,
       emotion_entry || null, emotion_exit || null, JSON.stringify(tags || [])]
    );

    // db.query() returns { rows: [], insertId, affectedRows } for INSERTs.
    // rows is always empty, so we must re-SELECT to return the row.
    const insertId = insert.insertId;
    console.log(
      `[TRADE_JOURNAL] INSERT user=${user.id} symbol=${tradingsymbol.toUpperCase()} ` +
      `dir=${direction} qty=${quantity} entry=${entry_price} insertId=${insertId ?? 'undefined'}`
    );
    if (!insertId) {
      console.error('[TRADE_JOURNAL] ❌ insertId undefined — INSERT did not return an id');
      return NextResponse.json({ error: 'insert_failed' }, { status: 500 });
    }
    const { rows: fresh } = await db.query(
      `SELECT * FROM trade_journal WHERE id = ?`,
      [insertId],
    );
    if (!fresh[0]) {
      console.error(`[TRADE_JOURNAL] ❌ re-SELECT returned no row for id=${insertId}`);
    }
    console.log('OK OK ✅ API SUCCESS  /api/trade-journal  POST');
    return NextResponse.json({ trade: fresh[0] ?? null, id: insertId }, { status: 201 });
  } catch (e: any) {
    console.error('[TRADE_JOURNAL] POST failed:', e?.message ?? e);
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireSession();
    const { id, exit_price, exit_date, notes, emotion_exit } = await req.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    // Re-compute outcome
    const { rows: existing } = await db.query(`SELECT * FROM trade_journal WHERE id=? AND user_id=?`, [id, user.id]);
    if (!existing.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const t      = existing[0];
    let pnl      = t.pnl;
    let pnl_pct  = t.pnl_pct;
    let outcome  = t.outcome;

    if (exit_price) {
      const exitNum  = parseFloat(exit_price);
      const entryNum = parseFloat(t.entry_price);
      pnl     = t.direction === 'BUY' ? (exitNum - entryNum) * t.quantity : (entryNum - exitNum) * t.quantity;
      pnl_pct = (pnl / (entryNum * t.quantity)) * 100;
      outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
    }

    await db.query(
      `UPDATE trade_journal SET exit_price=?, exit_date=?, notes=?, emotion_exit=?, outcome=?, pnl=?, pnl_pct=? WHERE id=? AND user_id=?`,
      [exit_price ? parseFloat(exit_price) : t.exit_price, exit_date || t.exit_date, notes || t.notes, emotion_exit || t.emotion_exit, outcome, pnl, pnl_pct, id, user.id]
    );

    return NextResponse.json({ success: true, outcome, pnl, pnl_pct });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
