// ════════════════════════════════════════════════════════════════
//  GET /api/pipeline/portfolio
//
//  Returns the live portfolio snapshot maintained by
//  portfolioTracker. The tracker is event-driven — it updates from
//  fills (execution worker) and from ticks (strategy worker's
//  mark-to-market hook). This endpoint only reads from memory.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { snapshot, loadPortfolio } from '@/lib/pipeline/portfolioTracker';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

let hydrated = false;

export async function GET(): Promise<NextResponse> {
  if (!hydrated) {
    await loadPortfolio().catch(() => { /* first call, empty hash */ });
    hydrated = true;
  }
  const snap = snapshot();
  return NextResponse.json(
    {
      now:       new Date().toISOString(),
      ...snap,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
