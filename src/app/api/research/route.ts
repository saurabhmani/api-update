// POST /api/research — AI Research Assistant (acceptance spec)

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import {
  generateResearchReport,
  explainSignal,
  explainMarketConditions,
  explainBacktest,
  listResearchReports,
} from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const action = req.nextUrl.searchParams.get('action');

  if (action === 'market') {
    return { sections: await explainMarketConditions() };
  }
  if (action === 'signal') {
    const symbol = req.nextUrl.searchParams.get('symbol');
    if (!symbol) return { error: 'symbol required', statusCode: 400 };
    return { sections: await explainSignal(symbol) };
  }
  if (action === 'backtest') {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return { error: 'id required', statusCode: 400 };
    return { sections: await explainBacktest(id) };
  }

  const reports = await listResearchReports(user.id);
  return { reports };
});

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json().catch(() => ({}));
  const type = body.type ?? 'full';
  const report = await generateResearchReport(user.id, {
    type,
    symbol: body.symbol,
    backtestId: body.backtestId,
  });
  return { report };
});
