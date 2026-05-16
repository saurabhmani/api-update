import { NextRequest, NextResponse } from 'next/server';
import { runCustomUniverseScan } from '@/lib/scanner/customUniverseBatchScanner';
import { getScannerState, setScannerState } from '@/lib/scanner/scannerState';
import { logger } from '@/lib/logger';

const log = logger.child({ route: '/api/scanner/custom-universe/run' });

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const isAsync = url.searchParams.get('async') === 'true';

    const state = getScannerState();
    if (state.inFlight) {
      return NextResponse.json({ error: 'Scanner is already running' }, { status: 409 });
    }

    setScannerState({ inFlight: true, status: 'running', batchId: `run-${Date.now()}` });

    if (isAsync) {
      // Run in background
      Promise.resolve().then(async () => {
        try {
          await runCustomUniverseScan();
        } catch (err) {
          log.error('Async scanner run failed', { error: (err as Error).message });
        } finally {
          setScannerState({ inFlight: false, status: 'idle' });
        }
      });
      return NextResponse.json({ message: 'Scanner started in background' });
    } else {
      // Run synchronously
      const result = await runCustomUniverseScan();
      setScannerState({ inFlight: false, status: 'idle' });
      return NextResponse.json(result);
    }
  } catch (err) {
    setScannerState({ inFlight: false, status: 'idle' });
    log.error('Scanner run failed', { error: (err as Error).message });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
