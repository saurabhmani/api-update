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

  // MODULE-API-RESILIENCE-2026-05 — wrap analyzeOptionChain so a thrown
  // error (provider auth fail, parser blowup, etc.) returns the same
  // `intelligence: null` shape the UI already handles. Without this,
  // an unhandled throw lands as 500 → dashboard shows "Option
  // Intelligence: fetch failed".
  try {
    const intel = await analyzeOptionChain(symbol, expiryIndex);
    if (!intel) {
      return NextResponse.json({
        intelligence: null,
        error: 'Option chain data unavailable for this symbol',
      });
    }
    return NextResponse.json({ intelligence: intel });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('[MODULE_API_FAIL]', {
      route:   '/api/options/intelligence',
      stage:   'analyzeOptionChain',
      symbol,
      expiry:  expiryIndex,
      message: e.message,
      stack:   e.stack?.split('\n').slice(0, 6).join('\n'),
    });
    return NextResponse.json({
      intelligence: null,
      degraded:     true,
      error:        'Option intelligence degraded',
      details:      e.message,
    });
  }
}
