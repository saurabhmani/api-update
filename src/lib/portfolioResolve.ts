// ════════════════════════════════════════════════════════════════
//  Portfolio ID resolution helper
//
//  Many GET routes (risk/*, portfolio/*, alerts/breaches, …) need
//  the caller's portfolio id, falling back to "the user's first
//  portfolio" when no explicit ?portfolioId= is given.
//
//  The previous pattern was duplicated in 20+ routes:
//      const { rows } = await db.query('SELECT id FROM portfolios …');
//      if (!rows.length) throw new ValidationError('No portfolio found');
//
//  That throw produced a 400 + a "Request failed (operational)" warn
//  on every dashboard load by a user who has not created a portfolio
//  yet (which is every brand-new user). The dashboard saw a 400, the
//  ops logs filled with confusing "VALIDATION_ERROR" lines, and the
//  empty-state UI never rendered.
//
//  This helper returns null in that case so each route can respond
//  with its own empty-data shape (e.g. { data: [], hasPortfolio: false })
//  and the dashboard can render cleanly.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

export async function resolveUserPortfolioId(
  userId: number,
  explicitParam: string | null,
): Promise<number | null> {
  if (explicitParam) {
    const parsed = Number(explicitParam);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const { rows } = await db.query(
    'SELECT id FROM portfolios WHERE user_id = ? LIMIT 1',
    [userId],
  );
  if (!rows.length) return null;
  return Number((rows[0] as any).id);
}
