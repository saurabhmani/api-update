import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();

    // Get user plan
    const { rows: planRows } = await db.query(
      `SELECT plan, expires_at FROM user_plans WHERE user_id=?`, [user.id]
    );
    const plan = planRows[0]?.plan ?? 'free';

    // Get entitlements for this plan
    const { rows: ents } = await db.query(
      `SELECT feature_key, enabled FROM feature_entitlements WHERE plan=?`, [plan]
    );

    const features: Record<string, boolean> = {};
    for (const e of ents) features[e.feature_key] = e.enabled;

    // Admin always gets all features
    if (user.role === 'admin') {
      for (const key of Object.keys(features)) features[key] = true;
    }

    return NextResponse.json({ plan, features, user_id: user.id });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

// Admin: upgrade user plan
export async function PUT() {
  return NextResponse.json({ error: 'Use admin panel to manage plans' }, { status: 400 });
}
