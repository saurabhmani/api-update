// GET /api/governance/restrictions — List active restrictions
// POST /api/governance/restrictions — Add a new restriction
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getRestrictions } from '@/services/governanceService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  await requireSession();
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
    ? Number(req.nextUrl.searchParams.get('portfolioId'))
    : undefined;

  const restrictions = await getRestrictions(portfolioId);
  return { data: restrictions, count: restrictions.length };
});

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  // Only admins can add restrictions
  if (user.role !== 'admin') {
    throw new ValidationError('Admin access required to manage restrictions');
  }

  const body = await req.json();
  const { ticker, sector, restrictionType, reason, portfolioId } = body;

  if (!restrictionType) throw new ValidationError('restrictionType is required');
  if (!ticker && !sector) throw new ValidationError('ticker or sector is required');

  await db.query(
    `INSERT INTO governance_restrictions (ticker, sector, restriction_type, reason, portfolio_id)
     VALUES (?, ?, ?, ?, ?)`,
    [ticker ?? null, sector ?? null, restrictionType, reason ?? null, portfolioId ?? null],
  );

  return { message: 'Restriction added' };
});
