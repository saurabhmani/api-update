// GET /api/risk/liquidity — Liquidity stress analysis per holding
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { computeLiquidity } from '@/services/riskCoreService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioIdParam = req.nextUrl.searchParams.get('portfolioId');

  let portfolioId: number;
  if (portfolioIdParam) {
    portfolioId = Number(portfolioIdParam);
  } else {
    const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [user.id]);
    if (!rows.length) throw new ValidationError('No portfolio found');
    portfolioId = (rows[0] as any).id;
  }

  const result = await computeLiquidity(portfolioId);
  return { data: result };
});
