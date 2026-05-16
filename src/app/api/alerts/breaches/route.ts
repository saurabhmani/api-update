// GET /api/alerts/breaches — Active portfolio breaches
// PATCH /api/alerts/breaches — Acknowledge a breach
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getActiveBreaches, acknowledgeBreach } from '@/services/breachDetectionService';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioId = await resolveUserPortfolioId(user.id, req.nextUrl.searchParams.get('portfolioId'));
  // Empty arrays (not null) so the dashboard can still .map / .length
  // without a null-guard at every call site.
  if (portfolioId == null) {
    return { data: [], count: 0, criticalCount: 0, hasPortfolio: false };
  }

  const breaches = await getActiveBreaches(portfolioId);
  return {
    data: breaches,
    count: breaches.length,
    criticalCount: breaches.filter((b) => b.severity === 'critical').length,
    hasPortfolio: true,
  };
});

export const PATCH = withApiHandler(async (req: NextRequest) => {
  await requireSession();
  const body = await req.json();
  if (!body.breachId) throw new ValidationError('breachId is required');
  await acknowledgeBreach(Number(body.breachId));
  return { message: 'Breach acknowledged' };
});
