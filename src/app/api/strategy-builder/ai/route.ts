import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { parseStrategy, definitionToJson, serializeToDsl, buildBacktestConfig } from '@/lib/strategy-lab';

export const dynamic = 'force-dynamic';

/** POST /api/strategy-builder/ai — natural language → structured rules + JSON */
export async function POST(req: NextRequest) {
  try {
    await requireSession();
    const body = await req.json().catch(() => ({}));
    const text = String(body.text ?? body.prompt ?? '');
    if (!text.trim()) {
      return NextResponse.json({ ok: false, error: 'text or prompt required' }, { status: 400 });
    }
    const definition = parseStrategy({ text, name: body.name ?? 'AI Strategy' });
    const json = definitionToJson(definition);
    const dsl = serializeToDsl(definition);
    const backtestConfig = buildBacktestConfig(definition, definition.id ?? 'unsaved-ai-strategy');
    return NextResponse.json({ ok: true, definition, json: JSON.parse(json), dsl, backtestConfig });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI parse failed';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
