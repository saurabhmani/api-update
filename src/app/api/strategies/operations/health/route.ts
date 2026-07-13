import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadHealthStatus } from '@/lib/strategy-hub/services/strategyOperationsService';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSession();
    const health = await loadHealthStatus();
    return NextResponse.json({ ok: true, health, generatedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load health status' }, { status: 500 });
  }
}
