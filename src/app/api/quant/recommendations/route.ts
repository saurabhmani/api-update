// GET /api/quant/recommendations — regime-aware strategy recommendations

import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { getStrategyRecommendations } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async () => {
  const user = await requireSession();
  const data = await getStrategyRecommendations(user.id);
  return { data };
});
