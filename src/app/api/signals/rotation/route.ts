// ════════════════════════════════════════════════════════════════
//  GET /api/signals/rotation
//
//  Verification endpoint that reports whether the strict-filter
//  signal set is rotating across calls. Each invocation:
//    1. Loads the same signal set /api/signals?action=all returns
//       (closed-market loader off-hours, confirmed-snapshot bundle
//       during live hours).
//    2. Diffs the IDs vs the previous call.
//    3. Updates the in-process lifecycle map.
//
//  Output shape:
//    {
//      previous, current,
//      new, removed, unchanged,
//      previous_count, current_count, new_count,
//      removed_count, unchanged_count,
//      rotation_percent,
//      first_observation,
//      lifecycle: [{ id, symbol, direction, first_seen_at,
//                    last_seen_at, status }, …]
//    }
//
//  No upstream API calls. Auth-gated like every dashboard endpoint.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { loadClosedMarketSignals } from '@/lib/signals/closedMarketSignals';
import { loadConfirmedSignalsBundle } from '@/lib/signals/confirmedSignalsService';
import { recordSnapshot } from '@/lib/signals/signalRotationTracker';
import type { ConfirmedSignalRow } from '@/lib/signals/signalsResponseMapper';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const limit = 30;
  let signals: ConfirmedSignalRow[] = [];
  let mode: 'live' | 'market_closed' = 'live';

  if (!isMarketOpen()) {
    mode = 'market_closed';
    const bundle = await loadClosedMarketSignals({ limit });
    signals = bundle.signals;
  } else {
    const bundle = await loadConfirmedSignalsBundle({ limit });
    signals = bundle.finalRows;
  }

  const diff = recordSnapshot(signals.map((s) => ({
    id:        Number(s.id ?? 0),
    symbol:    (s.symbol ?? s.tradingsymbol ?? null) as string | null,
    direction: (s.direction ?? null) as string | null,
  })));

  console.log(
    `[ROTATION] mode=${mode}  prev=${diff.previous_count}  cur=${diff.current_count}  ` +
    `new=${diff.new_count}  removed=${diff.removed_count}  unchanged=${diff.unchanged_count}  ` +
    `rotation=${diff.rotation_percent}%`,
  );

  return NextResponse.json(
    { mode, ...diff },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
