// ════════════════════════════════════════════════════════════════
//  POST /api/manipulation/eod-ingest
//
//  Triggers the free-source EOD candle ingestion pipeline. Pulls one
//  trading day's NSE bhavcopy (BSE / bulk-deal / ASM follow in later
//  rounds), upserts into the `candles` warehouse, returns a JSON
//  summary the UI can render directly.
//
//  Auth: requires a valid session — same gate the manual "Run Full
//  Scan" button uses (POST /api/manipulation).
//
//  No HTML errors: every failure path returns JSON with a clear
//  `error` field so the dashboard's readJsonOrThrow helper never
//  trips on an opaque 500.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runDailyEodIngestion } from '@/lib/marketData/eod/eodIngestionPipeline';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { date?: string; timeoutMs?: number } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine — defaults to most recent weekday.
  }

  // Light validation. The adapter does its own deeper validation but
  // we want to bounce obviously-wrong shapes here so the operator
  // sees a 400 instead of a generic FAILED status downstream.
  if (body.date !== undefined && typeof body.date !== 'string') {
    return NextResponse.json(
      { error: 'date must be a YYYY-MM-DD string' },
      { status: 400 },
    );
  }
  if (body.timeoutMs !== undefined && !Number.isFinite(body.timeoutMs)) {
    return NextResponse.json(
      { error: 'timeoutMs must be a number' },
      { status: 400 },
    );
  }

  try {
    const result = await runDailyEodIngestion({
      date:      body.date,
      timeoutMs: body.timeoutMs,
    });
    return NextResponse.json(result);
  } catch (err) {
    // The pipeline itself promises not to throw, but defend against
    // future regressions so the UI never sees a stack trace.
    return NextResponse.json(
      {
        ok:    false,
        error: 'EOD ingestion failed unexpectedly',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
