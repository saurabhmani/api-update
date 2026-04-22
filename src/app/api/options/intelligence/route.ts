import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { analyzeOptionChain } from '@/services/optionIntelligence';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const symbol      = req.nextUrl.searchParams.get('symbol') || 'NIFTY';
  const expiryIndex = parseInt(req.nextUrl.searchParams.get('expiry') || '0');

  const intel = await analyzeOptionChain(symbol, expiryIndex);
  if (!intel)  return NextResponse.json({ error: 'Option chain data unavailable for this symbol' }, { status: 503 });

  return NextResponse.json({ intelligence: intel });
}
