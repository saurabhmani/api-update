import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadSignalEngineMonitor } from '@/lib/strategy-hub/services/strategyOperationsService';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSession();
    const engine = await loadSignalEngineMonitor();
    return NextResponse.json({ ok: true, engine, generatedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load engine status' }, { status: 500 });
  }
}
