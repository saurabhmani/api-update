import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DIRECTIONS = new Set(['BUY', 'SELL']);
const OUTCOMES = new Set(['open', 'win', 'loss', 'breakeven']);

function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw || '50', 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, n));
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asDateString(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isFinite(d.getTime()) ? String(value) : null;
}

function normalizeTags(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    try {
      return normalizeTags(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .slice(0, 20),
  ));
}

function computeOutcome(direction: string, entryPrice: number, exitPrice: number | null, quantity: number) {
  if (exitPrice == null) return { outcome: 'open', pnl: null as number | null, pnl_pct: null as number | null };
  const pnl = direction === 'BUY'
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
  const basis = entryPrice * quantity;
  const pnl_pct = basis > 0 ? (pnl / basis) * 100 : 0;
  const outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  return {
    outcome,
    pnl: Number(pnl.toFixed(2)),
    pnl_pct: Number(pnl_pct.toFixed(4)),
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const limit = clampLimit(req.nextUrl.searchParams.get('limit'));
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

    const symbol = String(tradingsymbol || '').trim().toUpperCase();
    const dir = String(direction || '').trim().toUpperCase();
    const entryNum = asNumber(entry_price);
    const exitNum = asNumber(exit_price);
    const qtyNum = Number.parseInt(String(quantity ?? ''), 10);
    const entryDate = asDateString(entry_date);
    const exitDate = asDateString(exit_date);

    if (!symbol || !dir || entryNum == null || !qtyNum || !entryDate) {
      return NextResponse.json({ error: 'tradingsymbol, direction, entry_price, quantity, entry_date required' }, { status: 400 });
    }
    if (!DIRECTIONS.has(dir)) return NextResponse.json({ error: 'direction must be BUY or SELL' }, { status: 400 });
    if (entryNum <= 0) return NextResponse.json({ error: 'entry_price must be greater than 0' }, { status: 400 });
    if (qtyNum <= 0) return NextResponse.json({ error: 'quantity must be greater than 0' }, { status: 400 });
    if (exit_price !== undefined && exit_price !== '' && (exitNum == null || exitNum <= 0)) {
      return NextResponse.json({ error: 'exit_price must be greater than 0 when provided' }, { status: 400 });
    }
    if (exitNum != null && !exitDate) return NextResponse.json({ error: 'exit_date required when exit_price is provided' }, { status: 400 });

    const { outcome, pnl, pnl_pct } = computeOutcome(dir, entryNum, exitNum, qtyNum);
    const normalizedTags = normalizeTags(tags);

    const insert = await db.query(`
      INSERT INTO trade_journal
        (user_id, tradingsymbol, exchange, direction, entry_price, exit_price, quantity,
         entry_date, exit_date, strategy, timeframe, notes, outcome, pnl, pnl_pct,
         emotion_entry, emotion_exit, tags)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [user.id, symbol, exchange || 'NSE', dir,
       entryNum, exitNum,
       qtyNum, entryDate, exitDate, strategy || null,
       timeframe || null, notes || null, outcome, pnl, pnl_pct,
       emotion_entry || null, emotion_exit || null, JSON.stringify(normalizedTags)]
    );

    // db.query() returns { rows: [], insertId, affectedRows } for INSERTs.
    // rows is always empty, so we must re-SELECT to return the row.
    const insertId = insert.insertId;
    console.log(
      `[TRADE_JOURNAL] INSERT user=${user.id} symbol=${symbol} ` +
      `dir=${dir} qty=${qtyNum} entry=${entryNum} insertId=${insertId ?? 'undefined'}`
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
    const body = await req.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const { rows: existing } = await db.query(`SELECT * FROM trade_journal WHERE id=? AND user_id=?`, [id, user.id]);
    if (!existing.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const t = existing[0];
    const exitPrice = Object.prototype.hasOwnProperty.call(body, 'exit_price')
      ? asNumber(body.exit_price)
      : asNumber(t.exit_price);
    const exitDate = Object.prototype.hasOwnProperty.call(body, 'exit_date')
      ? asDateString(body.exit_date)
      : (t.exit_date ?? null);

    if (Object.prototype.hasOwnProperty.call(body, 'exit_price') && body.exit_price !== '' && (exitPrice == null || exitPrice <= 0)) {
      return NextResponse.json({ error: 'exit_price must be greater than 0 when provided' }, { status: 400 });
    }
    if (exitPrice != null && !exitDate) return NextResponse.json({ error: 'exit_date required when exit_price is provided' }, { status: 400 });

    const computed = computeOutcome(
      String(t.direction).toUpperCase(),
      Number(t.entry_price),
      exitPrice,
      Number(t.quantity),
    );
    const outcome = Object.prototype.hasOwnProperty.call(body, 'outcome') && OUTCOMES.has(String(body.outcome))
      ? String(body.outcome)
      : computed.outcome;
    const notes = Object.prototype.hasOwnProperty.call(body, 'notes') ? String(body.notes ?? '') : t.notes;
    const emotionEntry = Object.prototype.hasOwnProperty.call(body, 'emotion_entry') ? (body.emotion_entry || null) : t.emotion_entry;
    const emotionExit = Object.prototype.hasOwnProperty.call(body, 'emotion_exit') ? (body.emotion_exit || null) : t.emotion_exit;
    const strategy = Object.prototype.hasOwnProperty.call(body, 'strategy') ? (body.strategy || null) : t.strategy;
    const timeframe = Object.prototype.hasOwnProperty.call(body, 'timeframe') ? (body.timeframe || null) : t.timeframe;
    const tags = Object.prototype.hasOwnProperty.call(body, 'tags') ? normalizeTags(body.tags) : normalizeTags(t.tags);

    await db.query(
      `UPDATE trade_journal
          SET exit_price=?, exit_date=?, notes=?, emotion_entry=?, emotion_exit=?,
              strategy=?, timeframe=?, tags=?, outcome=?, pnl=?, pnl_pct=?
        WHERE id=? AND user_id=?`,
      [exitPrice, exitDate, notes, emotionEntry, emotionExit,
       strategy, timeframe, JSON.stringify(tags), outcome, computed.pnl, computed.pnl_pct, id, user.id]
    );

    const { rows: fresh } = await db.query(
      `SELECT * FROM trade_journal WHERE id=? AND user_id=?`,
      [id, user.id],
    );

    return NextResponse.json({ success: true, trade: fresh[0] ?? null });
  } catch (e: any) {
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('[TRADE_JOURNAL] PATCH failed:', e?.message ?? e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
