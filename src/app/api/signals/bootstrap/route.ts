// ════════════════════════════════════════════════════════════════
//  POST /api/signals/bootstrap
//
//  One-time NSE bootstrap trigger. Fires the safe-mode NSE direct
//  fetch for ~25 NIFTY top names ONLY when:
//
//    • the persistent flag `nse:bootstrap_used` is unset, AND
//    • q365_market_close_snapshot is empty, AND
//    • the market is open (or `?force=true` is passed).
//
//  Subsequent calls return `status: 'skipped'` with a reason — the
//  bootstrap cannot fire twice on the same install. Operator escape:
//  call clearBootstrapFlag() from a script if a re-bootstrap is
//  genuinely required.
//
//  Spec response shape:
//    { provider: "nse", bootstrap: true, message: "Initial real data loaded" }
//
//  GET on the same path returns the current bootstrap status without
//  triggering a run — useful for health checks.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  runOneTimeBootstrap,
  shouldRunBootstrap,
  isBootstrapDone,
} from '@/lib/marketData/oneTimeNseBootstrap';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const force = req.nextUrl.searchParams.get('force') === 'true';
  const result = await runOneTimeBootstrap({ force });

  // Spec response: provider/bootstrap/message are top-level. Extra
  // fields (status, symbolsFetched, reason) are kept for diagnostics
  // but the spec contract is satisfied by the first three keys.
  return NextResponse.json(result, {
    status: result.status === 'failed' ? 502 : 200,
  });
}

export async function GET(): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const done = await isBootstrapDone();
  const gate = await shouldRunBootstrap();
  return NextResponse.json({
    provider:        'nse',
    bootstrap:       true,
    flagSet:         done,
    wouldRun:        gate.should,
    reason:          gate.reason,
  });
}
