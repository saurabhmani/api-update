// GET /api/quant/event-risk — event risk detection for a symbol

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { detectEventRisk } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  await requireSession();
  const symbol = req.nextUrl.searchParams.get('symbol');
  if (!symbol) return { error: 'symbol required', statusCode: 400 };
  const data = await detectEventRisk(symbol);
  return { data };
});
