import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  parseStrategy,
  validateLabStrategy,
  previewLabStrategy,
  saveLabStrategy,
  listLabStrategies,
} from '@/lib/strategy-lab';

export const dynamic = 'force-dynamic';

/** POST /api/strategies/lab/parse */
export async function POST(req: NextRequest) {
  try {
    await requireSession();
    const body = await req.json().catch(() => ({}));
    const definition = parseStrategy({
      text: body.text,
      definition: body.definition,
      name: body.name,
    });
    return NextResponse.json({ ok: true, definition });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Parse failed';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

/** GET /api/strategies/lab — list saved strategies */
export async function GET() {
  try {
    await requireSession();
    const strategies = await listLabStrategies();
    return NextResponse.json({ ok: true, strategies });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
