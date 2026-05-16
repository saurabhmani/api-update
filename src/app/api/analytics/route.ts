import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const resource = req.nextUrl.searchParams.get('resource') || 'overview';
  const limit    = parseInt(req.nextUrl.searchParams.get('limit') || '20');

  if (resource === 'strategies') {
    const { rows } = await db.query(
      `SELECT s.*, COUNT(sp.id) as picks_count
       FROM strategies s LEFT JOIN strategy_picks sp ON sp.strategy_id=s.id
       WHERE s.is_active=TRUE GROUP BY s.id ORDER BY s.created_at DESC LIMIT ?`, [limit]
    );
    return NextResponse.json({ strategies: rows });
  }

  if (resource === 'signals') {
    const { rows } = await db.query(
      `SELECT * FROM signals ORDER BY generated_at DESC LIMIT ?`, [limit]
    );
    return NextResponse.json({ signals: rows });
  }

  if (resource === 'macro') {
    const { rows } = await db.query(`SELECT * FROM macro_data ORDER BY updated_at DESC`);
    return NextResponse.json({ macro: rows });
  }

  // Overview — aggregate stats
  const [rCount, sCount, nCount] = await Promise.all([
    db.query(`SELECT COUNT(*) as c FROM rankings`),
    db.query(`SELECT COUNT(*) as c FROM signals WHERE generated_at > NOW() - INTERVAL '7 days'`),
    db.query(`SELECT COUNT(*) as c FROM news WHERE is_published=TRUE`),
  ]);

  return NextResponse.json({
    overview: {
      ranked_stocks:  parseInt(rCount.rows[0].c),
      recent_signals: parseInt(sCount.rows[0].c),
      articles:       parseInt(nCount.rows[0].c),
    },
  });
}
