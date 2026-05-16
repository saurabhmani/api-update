// ════════════════════════════════════════════════════════════════
//  POST /api/bootstrap-nse
//
//  Spec alias for the safe-mode one-time NSE bootstrap. Mirrors the
//  contract of /api/signals/bootstrap and shares the same underlying
//  runner (`runOneTimeBootstrap`) so the persistent
//  `nse:bootstrap_used` flag is honoured across both paths — calling
//  one path consumes the bootstrap and the other path will then
//  return `status: 'skipped'` with `reason: 'flag_already_set'`.
//
//  Gates (all enforced by `runOneTimeBootstrap`):
//    1. `nse:bootstrap_used` flag unset
//    2. q365_market_close_snapshot empty
//    3. Market open OR `?force=true`
//
//  GET on the same path returns the current status without firing.
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
    provider:  'nse',
    bootstrap: true,
    flagSet:   done,
    wouldRun:  gate.should,
    reason:    gate.reason,
  });
}
