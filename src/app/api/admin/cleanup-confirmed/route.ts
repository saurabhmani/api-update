// ════════════════════════════════════════════════════════════════
//  POST /api/admin/cleanup-confirmed
//
//  One-shot cleanup: invalidate every ACTIVE row in
//  q365_confirmed_signal_snapshots that fails the current
//  institutional-confirmation thresholds. Rows are NEVER deleted —
//  they are flipped to status='INVALIDATED' so historical queries
//  still find them.
//
//  Predicate (any one fails → invalidate):
//    maturity_score              < 88
//    validation_cycles_passed    < 3
//    confidence_score            < 80
//    final_score                 < 75
//    rr_ratio                    < 2.2
//    expected_edge_percent       <= 2
//    classification IN ('DEVELOPING_SETUP','WATCHLIST_ONLY','NO_TRADE',
//                       'DEVELOPING','WATCHLIST')
//
//  Returns: { before, after, invalidated, scope: 'ACTIVE-only' }.
//  Re-running is safe: the second pass updates 0 rows because
//  everything that matched is no longer status='ACTIVE'.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import {
  CLEANUP_INVALIDATION_REASON,
  CLEANUP_PREDICATE_SQL,
}                            from '@/lib/signal-engine/api/cleanupPolicy';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // Optional dry-run: ?dryRun=true returns the would-invalidate count
  // without writing. Useful for operator verification before flipping
  // a populated table.
  const dryRun = req.nextUrl.searchParams.get('dryRun') === 'true';

  try {
    const beforeRes = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots WHERE status = 'ACTIVE'`,
    );
    const before = Number((beforeRes.rows[0] as any)?.c ?? 0);

    const targetRes = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots WHERE ${CLEANUP_PREDICATE_SQL}`,
    );
    const wouldInvalidate = Number((targetRes.rows[0] as any)?.c ?? 0);

    if (dryRun) {
      return NextResponse.json({
        ok:                 true,
        dry_run:            true,
        scope:              'ACTIVE-only',
        active_before:      before,
        would_invalidate:   wouldInvalidate,
        active_after_proj:  Math.max(0, before - wouldInvalidate),
        invalidation_reason: CLEANUP_INVALIDATION_REASON,
      });
    }

    const updateRes = await db.query(
      `UPDATE q365_confirmed_signal_snapshots
          SET status              = 'INVALIDATED',
              invalidation_reason = ?,
              status_changed_at   = NOW(),
              updated_at          = NOW()
        WHERE ${CLEANUP_PREDICATE_SQL}`,
      [CLEANUP_INVALIDATION_REASON],
    );

    const afterRes = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots WHERE status = 'ACTIVE'`,
    );
    const after = Number((afterRes.rows[0] as any)?.c ?? 0);

    return NextResponse.json({
      ok:                  true,
      dry_run:             false,
      scope:               'ACTIVE-only',
      active_before:       before,
      active_after:        after,
      invalidated:         (updateRes as any)?.affectedRows ?? (before - after),
      invalidation_reason: CLEANUP_INVALIDATION_REASON,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? 'cleanup_failed' },
      { status: 500 },
    );
  }
}
