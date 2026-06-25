import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { validateLabStrategy } from '@/lib/strategy-lab';
import type { StrategyDefinition } from '@/lib/strategy-lab/types';

export const dynamic = 'force-dynamic';

/** POST /api/strategy-builder/validate */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const definition = body.definition as StrategyDefinition;
    if (!definition) {
      return NextResponse.json({ ok: false, error: 'definition required' }, { status: 400 });
    }
    const validation = validateLabStrategy(
      definition,
      Boolean(body.backtestPassed),
      body.strategyId ?? definition.id,
      user.email,
    );
    return NextResponse.json({ ok: true, validation });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
