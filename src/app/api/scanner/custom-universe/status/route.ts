import { NextResponse } from 'next/server';
import {
  getScannerState,
  getProgress,
  getLastSummary,
  isInFlightStale,
  isInFlightStaleByNoProgress,
  forceClearInFlight,
} from '@/lib/scanner/scannerState';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/scanner/custom-universe/status
 *
 * Returns in-flight state, live per-symbol progress, and the most
 * recent ScannerSummary (memory + disk fallback). Used by the Signals
 * page auto-rebuild poll loop and operator dashboards.
 */
export async function GET() {
  if (isInFlightStaleByNoProgress()) {
    forceClearInFlight('status_no_progress_watchdog', 'FORCE RESET');
  } else if (isInFlightStale()) {
    forceClearInFlight('status_stale_watchdog');
  }

  const state = getScannerState();
  const progress = getProgress();
  const lastSummary = getLastSummary();

  return NextResponse.json({
    ...state,
    inFlight: state.inFlight,
    progress: progress
      ? {
          done:       progress.done,
          total:      progress.total,
          startedAt:  progress.startedAt,
          updatedAt:  progress.updatedAt,
          lastSymbol: progress.lastSymbol,
        }
      : null,
    lastSummary,
  });
}
