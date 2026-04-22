import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { explainMarket, explainInstrument } from '@/services/marketExplanation';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const type   = searchParams.get('type') || 'market';
  const symbol = searchParams.get('symbol');

  if (type === 'instrument' && symbol) {
    const explanation = await explainInstrument(symbol);
    if (!explanation) return NextResponse.json({ error: 'Could not explain instrument — check symbol' }, { status: 404 });
    return NextResponse.json({ explanation });
  }

  const explanation = await explainMarket();
  return NextResponse.json({ explanation });
}
