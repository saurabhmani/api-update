// GET /api/public/v1/recommendations — public strategy recommendations

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireApiKey, getStrategyRecommendations } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const ctx = await requireApiKey(req, 'read');
  const data = await getStrategyRecommendations(ctx.userId);
  return { version: 'v1', data };
});
