// GET /api/public/v1/market-regime — public market regime + sector rotation

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireApiKey, computeSectorRotation } from '@/lib/quant-platform';
import { getLatestRegime } from '@/lib/signal-engine/repository/readSignals';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  await requireApiKey(req, 'read');
  const [regime, rotation] = await Promise.all([
    getLatestRegime(),
    computeSectorRotation(),
  ]);
  return { version: 'v1', regime, rotation };
});
