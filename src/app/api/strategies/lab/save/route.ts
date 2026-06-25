import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { saveLabStrategy } from '@/lib/strategy-lab';
import type { StrategyDefinition } from '@/lib/strategy-lab/types';

export const dynamic = 'force-dynamic';

/** POST /api/strategies/lab/save */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const definition = body.definition as StrategyDefinition;
    if (!definition) {
      return NextResponse.json({ ok: false, error: 'definition required' }, { status: 400 });
    }
    const result = await saveLabStrategy(definition, user.email);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Save failed';
    const status = message === 'Unauthorized' ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
