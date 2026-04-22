import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// GET /api/user/onboarding
export async function GET() {
  try {
    const user = await requireSession();
    const { rows } = await db.query(
      `SELECT id, user_id, trader_type, preferred_segments, risk_profile,
              ui_mode, alert_mode, onboarding_completed,
              default_dashboard, timezone, alert_email, updated_at
       FROM user_preferences WHERE user_id = ?`, [user.id]
    );
    if (!rows.length) return NextResponse.json({ preferences: null, onboarding_completed: false });
    return NextResponse.json({ preferences: rows[0], onboarding_completed: rows[0].onboarding_completed });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

// POST /api/user/onboarding — create or upsert
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    const {
      trader_type = 'active_trader',
      preferred_segments = ['equities'],
      risk_profile = 'medium',
      ui_mode = 'pro',
      alert_mode = 'instant',
      default_dashboard = 'overview',
      timezone = 'Asia/Kolkata',
    } = body;

    await db.query(`
      INSERT INTO user_preferences
        (user_id, trader_type, preferred_segments, risk_profile, ui_mode,
         alert_mode, onboarding_completed, default_dashboard, timezone, updated_at)
      VALUES (?,?,?,?,?,?,TRUE,?,?,NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        trader_type          = EXCLUDED.trader_type,
        preferred_segments   = EXCLUDED.preferred_segments,
        risk_profile         = EXCLUDED.risk_profile,
        ui_mode              = EXCLUDED.ui_mode,
        alert_mode           = EXCLUDED.alert_mode,
        onboarding_completed = TRUE,
        default_dashboard    = EXCLUDED.default_dashboard,
        timezone             = EXCLUDED.timezone,
        updated_at           = NOW()
    `, [user.id, trader_type, preferred_segments, risk_profile, ui_mode,
        alert_mode, default_dashboard, timezone]);

    return NextResponse.json({ success: true, message: 'Onboarding preferences saved' });
  } catch (e: any) {
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 });
  }
}

// PUT /api/user/onboarding — update specific fields
export async function PUT(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json();
    const fields = ['trader_type','preferred_segments','risk_profile','ui_mode','alert_mode','default_dashboard','timezone','alert_email'];
    const updates: string[] = [];
    const values:  unknown[] = [];

    for (const field of fields) {
      if (body[field] !== undefined) {
        values.push(body[field]);
        updates.push(`${field} = $${values.length}`);
      }
    }

    if (!updates.length) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

    values.push(user.id);
    await db.query(
      `UPDATE user_preferences SET ${updates.join(', ')}, updated_at=NOW() WHERE user_id=$${values.length}`,
      values
    );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

