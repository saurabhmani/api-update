// GET /api/portfolio/holdings — Holdings with weights and sector breakdown
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getHoldings } from '@/services/portfolioLedgerService';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioId = await resolveUserPortfolioId(user.id, req.nextUrl.searchParams.get('portfolioId'));
  if (portfolioId == null) {
    return {
      data: { holdings: [], totalValue: 0, positionsCount: 0, sectorBreakdown: {} },
      hasPortfolio: false,
    };
  }

  const holdings = await getHoldings(portfolioId);
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);

  // Sector aggregation
  const sectorMap: Record<string, { value: number; weight: number; count: number }> = {};
  for (const h of holdings) {
    const sector = h.sector ?? 'Other';
    if (!sectorMap[sector]) sectorMap[sector] = { value: 0, weight: 0, count: 0 };
    sectorMap[sector].value += h.marketValue;
    sectorMap[sector].count += 1;
  }
  for (const s of Object.keys(sectorMap)) {
    sectorMap[s].weight = totalValue > 0
      ? parseFloat(((sectorMap[s].value / totalValue) * 100).toFixed(2))
      : 0;
  }

  return {
    data: {
      holdings,
      totalValue: parseFloat(totalValue.toFixed(2)),
      positionsCount: holdings.length,
      sectorBreakdown: sectorMap,
    },
    hasPortfolio: true,
  };
});
