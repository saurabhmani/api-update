// ════════════════════════════════════════════════════════════════
//  POST /api/admin/rescore
//
//  On-demand trigger for the dynamic-ranking rescore loop. Exists
//  so operators don't need to run `npx tsx ...` incantations with
//  --env-file flags every time they want to re-apply rule changes
//  to existing q365_signals rows.
//
//  The cron in workers/scheduler.ts runs this automatically every
//  minute during market hours — this endpoint just invokes the
//  same function, surfacing the RescoreResult as JSON so the UI
//  (or a curl operator) can inspect what changed.
//
//  Access: admin-only. Rescore writes to q365_signals (final_score,
//  decay_state, invalidation_reason, status), which is not safe to
//  expose to end users.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { rescoreActiveSignals } from '@/lib/signal-engine/rescore/rescoreActiveSignals';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  try {
    await requireAdmin();
  } catch (err) {
    // requireAdmin throws a Response — forward it as-is.
    if (err instanceof Response) return err;
    throw err;
  }

  const started = Date.now();
  try {
    const result = await rescoreActiveSignals();
    return NextResponse.json({
      ok:       true,
      result,
      totalMs:  Date.now() - started,
    });
  } catch (err: any) {
    console.error('[api/admin/rescore] failed:', err);
    return NextResponse.json(
      {
        ok:    false,
        error: err?.message ?? 'rescore failed',
      },
      { status: 500 },
    );
  }
}

// GET returns the same payload — convenient for browsers and for
// one-off diagnostic curls that don't want to fiddle with POST.
// The underlying function is idempotent w.r.t. repeated calls
// (the in-flight guard inside rescoreActiveSignals coalesces
// overlapping invocations into one run).
export const GET = POST;
