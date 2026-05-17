// ════════════════════════════════════════════════════════════════
//  POST /api/strategies/backfill
//
//  Operator-triggered backfill for the three Phase 1–6 closure
//  writers. Always returns 200 with a structured per-source result
//  so the operator can see exactly what was written / skipped.
//
//  Query / body params:
//    ?source=outcomes    → backfillSignalOutcomes
//    ?source=snapshots   → backfillStrategyPerformanceSnapshots
//    ?source=options     → backfillOptionsSnapshots
//    ?source=all         → run all three sequentially (default)
//    ?since=YYYY-MM-DD   → only used by outcomes (status_changed_at cutoff)
//
//  Auth: requires a valid session — same gate as the other
//  /api/strategies/* routes. Wrap in your own admin guard if you
//  want operator-only access.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { backfillSignalOutcomes }    from '@/lib/strategies/writers/signalOutcomesWriter';
import { backfillStrategyPerformanceSnapshots } from '@/lib/strategies/writers/strategySnapshotWriter';
import {
  backfillOptionsSnapshots,
  OPTIONS_FNO_WHITELIST,
} from '@/lib/strategies/writers/optionsSnapshotWriter';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

type Source = 'outcomes' | 'snapshots' | 'options' | 'all';

function parseSource(raw: string | null): Source {
  const v = String(raw ?? 'all').toLowerCase();
  return v === 'outcomes'  ? 'outcomes'
       : v === 'snapshots' ? 'snapshots'
       : v === 'options'   ? 'options'
       :                     'all';
}

export async function POST(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url = new URL(req.url);
  const source = parseSource(url.searchParams.get('source'));
  const since  = url.searchParams.get('since') || null;

  const ran: Record<string, unknown> = {};
  const startedAt = new Date().toISOString();

  try {
    if (source === 'outcomes' || source === 'all') {
      ran.outcomes = await backfillSignalOutcomes({ sinceIso: since });
    }
    if (source === 'snapshots' || source === 'all') {
      ran.snapshots = await backfillStrategyPerformanceSnapshots();
    }
    if (source === 'options' || source === 'all') {
      ran.options = await backfillOptionsSnapshots(OPTIONS_FNO_WHITELIST);
    }

    return NextResponse.json({
      ok:           true,
      source,
      startedAt,
      completedAt:  new Date().toISOString(),
      result:       ran,
    }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
  } catch (err) {
    // Soft-fail per the spec: structured 200 — never let a writer
    // failure 500. Operator can inspect `error` and re-run.
    return NextResponse.json({
      ok:           false,
      source,
      startedAt,
      completedAt:  new Date().toISOString(),
      error:        err instanceof Error ? err.message : String(err),
      result:       ran,
    });
  }
}

/** GET surfaces a small help payload so the operator can see what
 *  the endpoint expects without hitting POST first. */
export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }
  return NextResponse.json({
    ok: true,
    endpoint: '/api/strategies/backfill',
    method:   'POST',
    params:   {
      source: 'outcomes | snapshots | options | all (default: all)',
      since:  'YYYY-MM-DD — only used when source includes outcomes',
    },
    examples: [
      'POST /api/strategies/backfill',
      'POST /api/strategies/backfill?source=outcomes&since=2026-02-01',
      'POST /api/strategies/backfill?source=options',
    ],
    notes: [
      'outcomes  → q365_signal_outcomes  (Phase 2 Priority 1)',
      'snapshots → q365_strategy_performance_snapshots (Phase 2 Priority 2)',
      'options   → q365_options_snapshots (Phase 5 bulk-options closure)',
    ],
  });
  void req;
}
