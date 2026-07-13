import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadExecutiveAiSummary } from '@/lib/strategy-hub/services/strategyAiService';
import type { SummaryPeriod } from '@/lib/strategy-hub/ai/types';

export const dynamic = 'force-dynamic';

function parsePeriod(raw: string | null): SummaryPeriod {
  const v = String(raw ?? 'weekly').toLowerCase();
  if (v === 'daily' || v === 'weekly' || v === 'monthly') return v;
  return 'weekly';
}

/**
 * GET /api/strategies/ai/summary
 * Query: period=daily|weekly|monthly, skipCache=1
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const period = parsePeriod(req.nextUrl.searchParams.get('period'));
    const skipCache = req.nextUrl.searchParams.get('skipCache') === '1';

    const summary = await loadExecutiveAiSummary(period, skipCache);
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load executive summary' }, { status: 500 });
  }
}
