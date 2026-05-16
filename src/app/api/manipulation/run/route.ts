// ════════════════════════════════════════════════════════════════
//  POST /api/manipulation/run
//
//  Manual trigger for the manipulation scanner. Runs the full
//  pipeline end-to-end against the Phase 1 universe (or a caller-
//  supplied symbol list) and persists results into:
//    - q365_manipulation_snapshots
//    - q365_manipulation_events
//    - q365_manipulation_detector_results
//    - q365_manipulation_penalties (retroactive backfill)
//
//  Body (all optional):
//    { symbols?: string[], limit?: number, skipPenalties?: boolean }
//
//  Returns the ScanRunResult envelope — counts, band distribution,
//  penalties written, and wall-clock duration.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runManipulationScan } from '@/lib/workers/manipulationScanner';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;
// Full universe scan needs >10s on first run; bump the route timeout.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  let body: { symbols?: string[]; limit?: number; skipPenalties?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  try {
    const result = await runManipulationScan({
      universe:      body.symbols,
      limit:         body.limit,
      skipPenalties: body.skipPenalties,
    });
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[MANIPULATION] run failed:', err?.message);
    return NextResponse.json(
      { ok: false, error: 'Scan failed', details: err?.message },
      { status: 500 },
    );
  }
}
