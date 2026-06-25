// GET /api/public/v1/signals — public API (Bearer API key)

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireApiKey } from '@/lib/quant-platform';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  await requireApiKey(req, 'read');

  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 10)));
  const symbol = req.nextUrl.searchParams.get('symbol');

  const params: unknown[] = [];
  let where = `WHERE status IN ('active','watchlist')`;
  if (symbol) {
    where += ` AND symbol = ?`;
    params.push(symbol.toUpperCase());
  }
  params.push(limit);

  const { rows } = await db.query(
    `SELECT symbol, direction, confidence_score, strategy_group, market_regime,
            risk_score, risk_reward, updated_at
       FROM q365_signals ${where}
       ORDER BY confidence_score DESC LIMIT ?`,
    params,
  );

  return {
    version: 'v1',
    count: rows.length,
    signals: rows,
  };
});
