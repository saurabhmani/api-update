// ════════════════════════════════════════════════════════════════
//  POST /api/manipulation/daily-scan
//
//  Composed pipeline: EOD ingestion → manipulation scan in one call.
//  This is the button the operator clicks when Manipulation Watch
//  shows STALE and they want both halves to refresh in sequence.
//
//  The same function is also called by the 19:30 IST scheduler cron
//  (src/lib/workers/scheduler.ts) so the manual path and the
//  automated path produce byte-identical results.
//
//  Behaviour:
//    • Auth-gated (requireSession) — runs a multi-minute scan.
//    • Default = async 202 (avoids nginx 60s HTML 504). Pass
//      ?sync=true for cron that needs the full DailyScanResult.
//    • Always returns JSON, even on unexpected error.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runDailyManipulationScan } from '@/lib/manipulation-engine/pipeline/runDailyScan';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

let inFlight: Promise<unknown> | null = null;

export async function POST(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    date?:           string;
    timeoutMs?:      number;
    limit?:          number;
    skipIngestion?:  boolean;
    skipScan?:       boolean;
    skipPenalties?:  boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — defaults to today + full universe.
  }

  if (body.date !== undefined && typeof body.date !== 'string') {
    return NextResponse.json(
      { error: 'date must be a YYYY-MM-DD string' },
      { status: 400 },
    );
  }
  if (body.limit !== undefined && (!Number.isFinite(body.limit) || (body.limit as number) <= 0)) {
    return NextResponse.json(
      { error: 'limit must be a positive number' },
      { status: 400 },
    );
  }

  const wantsSync = req.nextUrl.searchParams.get('sync') === 'true';

  if (inFlight) {
    return NextResponse.json({
      ok: true,
      generationStatus: 'in_progress',
      reason: 'A daily manipulation scan is already running.',
    }, { status: 202, headers: { 'Retry-After': '5' } });
  }

  const work = runDailyManipulationScan({
    date:           body.date,
    timeoutMs:      body.timeoutMs,
    limit:          body.limit,
    skipIngestion:  body.skipIngestion,
    skipScan:       body.skipScan,
    skipPenalties:  body.skipPenalties,
  });
  const tracked = work.finally(() => {
    if (inFlight === tracked) inFlight = null;
  });
  inFlight = tracked;

  if (!wantsSync) {
    void tracked.catch((err) => {
      console.error('[API manipulation/daily-scan] background failed:', err);
    });
    return NextResponse.json({
      ok: true,
      generationStatus: 'in_progress',
      reason: 'Daily manipulation pipeline started in the background. Refresh shortly for results.',
      scan: {
        skipped: false,
        scanned: 0,
        snapshotsPersisted: 0,
        skippedInsufficient: 0,
        failed: 0,
        bandCounts: { low: 0, watch: 0, elevated: 0, high: 0, severe: 0 },
        penaltiesWritten: 0,
        durationMs: 0,
      },
    }, { status: 202, headers: { 'Retry-After': '5' } });
  }

  try {
    const result = await work;
    return NextResponse.json({ ...result, generationStatus: 'complete' });
  } catch (err) {
    return NextResponse.json(
      {
        ok:    false,
        error: 'Daily manipulation scan failed unexpectedly',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
