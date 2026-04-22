import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    );
    const unread = rows.filter((n: any) => !n.is_read).length;
    return NextResponse.json({ notifications: rows, unread });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const { id, all } = await req.json();
    if (all) {
      await db.query(`UPDATE notifications SET is_read=TRUE WHERE user_id=?`, [user.id]);
    } else if (id) {
      await db.query(`UPDATE notifications SET is_read=TRUE WHERE id=? AND user_id=?`, [id, user.id]);
    }
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
