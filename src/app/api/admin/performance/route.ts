import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { getSignalAccuracySummary } from '@/services/performanceTracker';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }

  const resource = req.nextUrl.searchParams.get('resource') || 'signals';

  if (resource === 'signals') {
    const summary = await getSignalAccuracySummary();
    const { rows: recent } = await db.query(`
      SELECT sp.*, s.tradingsymbol, s.signal_type, s.timeframe
      FROM signal_performance sp
      JOIN signals s ON s.id = sp.signal_id
      ORDER BY sp.checked_at DESC LIMIT 50
    `);
    return NextResponse.json({ summary, recent });
  }

  if (resource === 'setups') {
    const { rows: perf } = await db.query(`
      SELECT tsp.*, ts.tradingsymbol, ts.direction, ts.confidence
      FROM trade_setup_performance tsp
      JOIN trade_setups ts ON ts.id = tsp.setup_id
      ORDER BY tsp.checked_at DESC LIMIT 50
    `);

    const total    = perf.length;
    const hits     = perf.filter((p: any) => p.outcome === 'target_hit').length;
    const sl_hits  = perf.filter((p: any) => p.outcome === 'sl_hit').length;
    const pending  = perf.filter((p: any) => p.outcome === 'pending').length;
    const accuracy = (total - pending) > 0 ? ((hits / (total - pending)) * 100).toFixed(1) : '0';

    return NextResponse.json({ summary: { total, target_hit: hits, sl_hit: sl_hits, pending, accuracy_pct: parseFloat(accuracy) }, recent: perf });
  }

  if (resource === 'logs') {
    const { rows } = await db.query(`SELECT * FROM rule_execution_logs ORDER BY run_at DESC LIMIT 100`);
    return NextResponse.json({ logs: rows });
  }

  return NextResponse.json({ error: 'Invalid resource' }, { status: 400 });
}

