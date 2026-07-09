// ════════════════════════════════════════════════════════════════
//  POST /api/signal-engine/feedback/evaluate
//
//  Feedback loop orchestrator — Phase 4 §8.
//
//  Thin HTTP wrapper around runOutcomeEvaluation() in
//  src/lib/signal-engine/feedback/runOutcomeEvaluation.ts. The same
//  job also runs nightly from the worker scheduler so
//  q365_signal_outcomes stays fresh without manual triggers.
//
//  Request body (all optional):
//    {
//      signalId?: number,          // evaluate only this signal
//      maxAgeDays?: number,        // only consider signals generated
//                                  //   within the last N days (default 30)
//      minBarsSinceEntry?: number, // minimum post-signal candles required
//                                  //   to evaluate (default 5)
//      limit?: number,             // max signals to process (default 200)
//      staleHours?: number,        // incremental mode — skip signals whose
//                                  //   outcome was evaluated within N hours
//    }
//
//  Response:
//    {
//      processed_count: number,   // how many signals we looked at
//      updated_count: number,     // how many outcomes we wrote
//      skipped_count: number,     // insufficient data / already current
//      strategy_snapshots: number,
//      calibration_snapshots: number,
//      duration_ms: number,
//    }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runOutcomeEvaluation } from '@/lib/signal-engine/feedback/runOutcomeEvaluation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse body safely — accept empty/missing JSON.
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }

  try {
    const result = await runOutcomeEvaluation({
      signalId: typeof body.signalId === 'number' ? body.signalId : undefined,
      maxAgeDays: typeof body.maxAgeDays === 'number' ? body.maxAgeDays : undefined,
      minBarsSinceEntry:
        typeof body.minBarsSinceEntry === 'number' ? body.minBarsSinceEntry : undefined,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      staleHours: typeof body.staleHours === 'number' ? body.staleHours : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[feedback/evaluate]', err);
    return NextResponse.json(
      {
        error: 'Feedback evaluation failed',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
