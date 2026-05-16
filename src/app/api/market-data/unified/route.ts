// GET /api/market-data/unified — Single-source unified market dataset
//
// Returns breadth, gainers, losers, sectors, and volatility all
// derived from the SAME atomic dataset. No source mixing.
import { withApiHandler } from '@/lib/apiHandler';
import { fetchUnifiedMarketData } from '@/services/unifiedMarketData';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const GET = withApiHandler(async () => {
  const dataset = await fetchUnifiedMarketData();

  return {
    data: {
      breadth: dataset.breadth,
      topGainers: dataset.topGainers.map(s => ({
        symbol: s.symbol, name: s.name, ltp: s.ltp,
        change_percent: s.changePct, change_abs: s.changeAbs, volume: s.volume,
      })),
      topLosers: dataset.topLosers.map(s => ({
        symbol: s.symbol, name: s.name, ltp: s.ltp,
        change_percent: s.changePct, change_abs: s.changeAbs, volume: s.volume,
      })),
      sectors: dataset.sectors,
      volatility: dataset.volatility,
    },
    meta: {
      source: dataset.source,
      stockCount: dataset.stockCount,
      isComplete: dataset.isComplete,
      timestamp: dataset.timestamp,
    },
  };
});
