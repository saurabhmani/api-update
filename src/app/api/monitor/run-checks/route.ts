// POST /api/monitor/run-checks — Run full monitoring sweep
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { runMonitoringChecks } from '@/services/breachDetectionService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json().catch(() => ({}));

  let portfolioId = body.portfolioId;
  if (!portfolioId) {
    const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [user.id]);
    if (!rows.length) throw new ValidationError('No portfolio found');
    portfolioId = (rows[0] as any).id;
  }

  const result = await runMonitoringChecks(portfolioId);
  return { data: result };
});
