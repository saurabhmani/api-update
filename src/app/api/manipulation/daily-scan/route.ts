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
//    • Always returns JSON, even on unexpected error.
//    • Reports per-step success: ingestion success, candles advanced,
//      scanner success — so the UI can show "ingested but scan
//      failed" vs "scan ran on stale data" precisely.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runDailyManipulationScan } from '@/lib/manipulation-engine/pipeline/runDailyScan';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

  try {
    const result = await runDailyManipulationScan({
      date:           body.date,
      timeoutMs:      body.timeoutMs,
      limit:          body.limit,
      skipIngestion:  body.skipIngestion,
      skipScan:       body.skipScan,
      skipPenalties:  body.skipPenalties,
    });
    return NextResponse.json(result);
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
