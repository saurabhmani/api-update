import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  const { rows } = await db.query(`SELECT * FROM signal_rules ORDER BY weight DESC`);
  return NextResponse.json({ rules: rows });
}

export async function PUT(req: NextRequest) {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  const { id, weight, enabled } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  await db.query(
    `UPDATE signal_rules SET weight=COALESCE(?,weight), enabled=COALESCE(?,enabled), updated_at=NOW() WHERE id=?`,
    [weight ?? null, enabled ?? null, id]
  );
  return NextResponse.json({ success: true });
}
