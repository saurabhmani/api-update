// GET /api/quant/sentiment — news sentiment summary

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { getNewsSentiment } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  await requireSession();
  const symbol = req.nextUrl.searchParams.get('symbol') ?? undefined;
  const data = await getNewsSentiment(symbol);
  return { data };
});
