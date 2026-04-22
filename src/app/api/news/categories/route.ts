import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSession();
    const { rows } = await db.query(`SELECT * FROM news_categories ORDER BY name`);
    return NextResponse.json({ categories: rows });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
