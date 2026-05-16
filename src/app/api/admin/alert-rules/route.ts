import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { db } from '@/lib/db';
import { cacheDel } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const { rows } = await db.query(`SELECT * FROM alert_rules ORDER BY priority DESC, key`);
  return NextResponse.json({ rules: rows });
}

export async function PUT(req: NextRequest) {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  const { id, enabled, priority, cooldown_minutes, min_confidence } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  await db.query(
    `UPDATE alert_rules SET
       enabled           = COALESCE(?, enabled),
       priority          = COALESCE(?, priority),
       cooldown_minutes  = COALESCE(?, cooldown_minutes),
       min_confidence    = COALESCE(?, min_confidence),
       updated_at        = NOW()
     WHERE id = ?`,
    [enabled ?? null, priority ?? null, cooldown_minutes ?? null, min_confidence ?? null, id]
  );
  // Bust cache
  await cacheDel('alert_rules:active');
  return NextResponse.json({ success: true });
}

