import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { changePassword } from '@/services/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();
    const { rows } = await db.query(
      `SELECT * FROM user_preferences WHERE user_id=?`, [user.id]
    );
    return NextResponse.json({ preferences: rows[0] || {} });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    const { action } = body;

    if (action === 'change-password') {
      const { current_password, new_password } = body;
      if (!current_password || !new_password) {
        return NextResponse.json({ error: 'current_password and new_password required' }, { status: 400 });
      }
      const ok = await changePassword(user.id, current_password, new_password);
      if (!ok) return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    // Save preferences
    const { default_dashboard, timezone, alert_email } = body;
    await db.query(
      `INSERT INTO user_preferences (user_id, default_dashboard, timezone, alert_email, updated_at)
       VALUES (?,?,?,?,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         default_dashboard=?, timezone=?, alert_email=?, updated_at=NOW()`,
      [user.id, default_dashboard || 'overview', timezone || 'Asia/Kolkata', alert_email !== false]
    );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
