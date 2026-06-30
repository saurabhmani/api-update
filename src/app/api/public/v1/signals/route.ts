// GET /api/public/v1/signals — public signal feed with outcomes

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { cacheGet, cacheSet } from '@/lib/redis';
import { enforcePublicSignalsAccess } from '@/lib/signals/public/publicSignalsAccess';
import {
  buildPublicSignalsCacheKey,
  getPublicSignalsFeed,
  parsePublicSignalsQuery,
} from '@/lib/signals/public/publicSignalsService';

export const dynamic = 'force-dynamic';

const CACHE_TTL_SEC = 300;

const innerGet = withApiHandler(async (req: NextRequest) => {
  await enforcePublicSignalsAccess(req);

  const query = parsePublicSignalsQuery(req);
  const cacheKey = buildPublicSignalsCacheKey(query);
  const cached = await cacheGet<Record<string, unknown>>(cacheKey);
  if (cached) {
    return { version: 'v1', ...cached, cached: true };
  }

  const result = await getPublicSignalsFeed(query);
  const payload = {
    data: result.data,
    page: result.page,
    total: result.total,
    summary: result.summary,
    win_rate: result.win_rate,
    cached: false,
  };

  await cacheSet(cacheKey, payload, CACHE_TTL_SEC);

  return { version: 'v1', ...payload };
});

export async function GET(req: NextRequest, ctx?: unknown) {
  const res = await innerGet(req, ctx);
  res.headers.set('Cache-Control', 'public, max-age=300');
  return res;
}
