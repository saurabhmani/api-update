import { NextRequest, NextResponse } from 'next/server';
import { runCustomUniverseScan } from '@/lib/scanner/customUniverseBatchScanner';
import {
  getScannerState,
  setScannerState,
  setProgress,
  clearProgress,
  isInFlightStale,
  isInFlightStaleByNoProgress,
  forceClearInFlight,
} from '@/lib/scanner/scannerState';
import { logger } from '@/lib/logger';
import { requireAdmin } from '@/lib/session';

const log = logger.child({ route: '/api/scanner/custom-universe/run' });

function clearStaleLockIfNeeded(): void {
  if (isInFlightStaleByNoProgress()) {
    forceClearInFlight('run_no_progress_watchdog', 'FORCE RESET');
  } else if (isInFlightStale()) {
    forceClearInFlight('run_stale_watchdog');
  }
}

const scanProgressOpts = {
  onProgress(done: number, total: number, last: { symbol?: string }) {
    setProgress(done, total, last.symbol ?? null);
  },
};

export async function POST(req: NextRequest) {
  try { await requireAdmin(); }
  catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  try {
    clearStaleLockIfNeeded();

    const url = new URL(req.url);
    const isAsync = url.searchParams.get('async') === 'true';

    const state = getScannerState();
    if (state.inFlight) {
      return NextResponse.json({ error: 'Scanner is already running' }, { status: 409 });
    }

    clearProgress();
    setScannerState({ inFlight: true, status: 'running', batchId: `run-${Date.now()}` });

    if (isAsync) {
      Promise.resolve().then(async () => {
        try {
          await runCustomUniverseScan(scanProgressOpts);
        } catch (err) {
          log.error('Async scanner run failed', { error: (err as Error).message });
        } finally {
          setScannerState({ inFlight: false, status: 'idle' });
          clearProgress();
        }
      });
      return NextResponse.json({ message: 'Scanner started in background' });
    }

    const result = await runCustomUniverseScan(scanProgressOpts);
    setScannerState({ inFlight: false, status: 'idle' });
    clearProgress();
    return NextResponse.json(result);
  } catch (err) {
    setScannerState({ inFlight: false, status: 'idle' });
    clearProgress();
    log.error('Scanner run failed', { error: (err as Error).message });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
