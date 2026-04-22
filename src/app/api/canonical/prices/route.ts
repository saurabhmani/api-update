// GET /api/canonical/prices — Canonical price history
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getPrices } from '@/services/canonicalDataService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const ticker = sp.get('ticker') ?? undefined;
  const instrumentId = sp.get('instrumentId') ? Number(sp.get('instrumentId')) : undefined;

  if (!ticker && !instrumentId) {
    return { data: [], count: 0, error: 'ticker or instrumentId required' };
  }

  const prices = await getPrices({
    ticker,
    instrumentId,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : 250,
  });
  return { data: prices, count: prices.length };
});
