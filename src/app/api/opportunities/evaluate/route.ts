// POST /api/opportunities/evaluate — Full pipeline evaluation (risk + governance)
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { evaluateOpportunity } from '@/services/opportunityService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, quantity, price } = body;

  if (!ticker || !quantity || !price) {
    throw new ValidationError('ticker, quantity, and price are required');
  }

  let portfolioId = body.portfolioId;
  if (!portfolioId) {
    const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [user.id]);
    if (!rows.length) throw new ValidationError('No portfolio found');
    portfolioId = (rows[0] as any).id;
  }

  const evaluation = await evaluateOpportunity(
    ticker.toUpperCase(), portfolioId, Number(quantity), Number(price), user.id,
  );
  return { data: evaluation };
});
