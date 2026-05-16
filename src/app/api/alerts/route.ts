import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();
    const { rows } = await db.query(
      `SELECT * FROM alerts WHERE user_id=? ORDER BY created_at DESC`,
      [user.id]
    );
    return NextResponse.json({ alerts: rows });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const { instrument_key, tradingsymbol, condition, target_price } = await req.json();
    if (!tradingsymbol || !target_price) {
      return NextResponse.json({ error: 'tradingsymbol and target_price required' }, { status: 400 });
    }
    const { rows } = await db.query(
      `INSERT INTO alerts (user_id, instrument_key, tradingsymbol, \`condition\`, target_price)
       VALUES (?,?,?,?,?) `,
      [user.id, instrument_key || null, tradingsymbol, condition || 'above', parseFloat(target_price)]
    );
    return NextResponse.json({ alert: rows[0] }, { status: 201 });
  } catch (e: any) {
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireSession();
    const { id, condition, target_price, is_active } = await req.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await db.query(
      `UPDATE alerts SET \`condition\`=?, target_price=?, is_active=? WHERE id=? AND user_id=?`,
      [condition, parseFloat(target_price), is_active, id, user.id]
    );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireSession();
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await db.query(`DELETE FROM alerts WHERE id=? AND user_id=?`, [id, user.id]);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
