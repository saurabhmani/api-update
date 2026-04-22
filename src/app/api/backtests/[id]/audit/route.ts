// ════════════════════════════════════════════════════════════════
//  GET /api/backtests/:id/audit
//  Returns the audit log entries for a backtest run, ordered by bar.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await ensureBacktestTables();

    const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '500', 10);
    const action = req.nextUrl.searchParams.get('action');

    let sql = `SELECT bar_index, timestamp, action, symbol, message, payload_json
               FROM backtest_audit_logs
               WHERE run_id = ?`;
    const queryParams: any[] = [params.id];

    if (action) {
      sql += ` AND action = ?`;
      queryParams.push(action);
    }

    sql += ` ORDER BY bar_index ASC, id ASC LIMIT ?`;
    queryParams.push(limit);

    const { rows } = await db.query(sql, queryParams);

    return NextResponse.json({
      runId: params.id,
      logs: rows,
      total: rows.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load audit log', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
