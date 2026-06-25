import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { validateLabStrategy } from '@/lib/strategy-lab';
import type { StrategyDefinition } from '@/lib/strategy-lab/types';

export const dynamic = 'force-dynamic';

/** POST /api/strategies/lab/validate */
export async function POST(req: NextRequest) {
  try {
    await requireSession();
    const body = await req.json().catch(() => ({}));
    const definition = body.definition as StrategyDefinition;
    if (!definition) {
      return NextResponse.json({ ok: false, error: 'definition required' }, { status: 400 });
    }
    const validation = validateLabStrategy(definition, Boolean(body.backtestPassed));
    return NextResponse.json({ ok: true, validation });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
