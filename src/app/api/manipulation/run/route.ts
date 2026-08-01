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
//  Default = async 202 (avoids nginx 60s HTML 504). Pass ?sync=true
//  for cron/CLI that need the full ScanRunResult envelope.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runManipulationScan } from '@/lib/workers/manipulationScanner';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

let inFlight: Promise<unknown> | null = null;

export async function POST(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  let body: { symbols?: string[]; limit?: number; skipPenalties?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const wantsSync = req.nextUrl.searchParams.get('sync') === 'true';

  if (inFlight) {
    return NextResponse.json({
      ok: true,
      generationStatus: 'in_progress',
      note: 'A manipulation scan is already running.',
    }, { status: 202, headers: { 'Retry-After': '5' } });
  }

  const work = runManipulationScan({
    universe:      body.symbols,
    limit:         body.limit,
    skipPenalties: body.skipPenalties,
  });
  const tracked = work.finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;

  if (!wantsSync) {
    void tracked.catch((err: any) => {
      console.error('[MANIPULATION] background run failed:', err?.message ?? err);
    });
    return NextResponse.json({
      ok: true,
      generationStatus: 'in_progress',
      note: 'Manipulation scan started in the background. Refresh shortly for results.',
    }, { status: 202, headers: { 'Retry-After': '5' } });
  }

  try {
    const result = await work;
    return NextResponse.json({
      ok: true,
      generationStatus: 'complete',
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
