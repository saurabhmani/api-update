// GET /api/alerts/breaches — Active portfolio breaches
// PATCH /api/alerts/breaches — Acknowledge a breach
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getActiveBreaches, acknowledgeBreach } from '@/services/breachDetectionService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  let portfolioId = req.nextUrl.searchParams.get('portfolioId')
    ? Number(req.nextUrl.searchParams.get('portfolioId'))
    : undefined;

  if (!portfolioId) {
    const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [user.id]);
    if (!rows.length) throw new ValidationError('No portfolio found');
    portfolioId = (rows[0] as any).id;
  }

  const breaches = await getActiveBreaches(portfolioId);
  return {
    data: breaches,
    count: breaches.length,
    criticalCount: breaches.filter((b) => b.severity === 'critical').length,
  };
});

export const PATCH = withApiHandler(async (req: NextRequest) => {
  await requireSession();
  const body = await req.json();
  if (!body.breachId) throw new ValidationError('breachId is required');
  await acknowledgeBreach(Number(body.breachId));
  return { message: 'Breach acknowledged' };
});
