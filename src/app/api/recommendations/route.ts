// GET /api/recommendations — Strategy Recommendation Engine (acceptance spec)

import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { getStrategyRecommendations } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async () => {
  const user = await requireSession();
  const result = await getStrategyRecommendations(user.id);
  return {
    regime: result.regime,
    regimeStatus: result.regimeStatus,
    overallConfidence: result.overallConfidence,
    recommendations: result.recommendations,
    ranking: result.ranking,
  };
});
