// POST /api/scenarios/run — Run a stress scenario against a portfolio
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { runScenario } from '@/services/scenarioStressService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { scenarioId, targetSector, dropPct } = body;

  if (!scenarioId) throw new ValidationError('scenarioId is required');

  let portfolioId = body.portfolioId;
  if (!portfolioId) {
    const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [user.id]);
    if (!rows.length) throw new ValidationError('No portfolio found');
    portfolioId = (rows[0] as any).id;
  }

  const result = await runScenario(portfolioId, scenarioId, { targetSector, dropPct });
  return { data: result };
});
