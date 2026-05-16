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
  if (!intel) {
    // Always 200: the endpoint itself is working. Callers detect
    // unavailability via `intelligence: null` (the UI already handles
    // this with an empty state).
    return NextResponse.json({
      intelligence: null,
      error: 'Option chain data unavailable for this symbol',
    });
  }

  return NextResponse.json({ intelligence: intel });
}
