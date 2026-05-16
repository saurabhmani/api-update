// GET /api/portfolio/ledger — Deterministic portfolio state from transactions
// GET /api/portfolio/ledger?action=validate — Validate snapshot vs ledger
// GET /api/portfolio/ledger?action=prove   — Run full determinism proof
// POST /api/portfolio/ledger — Sync snapshot from transaction truth
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import {
  rebuildPortfolioState,
  valuatePortfolioState,
  validateLedgerConsistency,
  syncSnapshotFromLedger,
  proveLedgerDeterminism,
} from '@/services/deterministicLedger';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';

export const dynamic = 'force-dynamic';

// Local helper — throws for the POST handler, where a missing portfolio
// genuinely is a validation error (you can't sync a snapshot for a
// portfolio that doesn't exist).
async function resolvePortfolio(userId: number, portfolioIdParam?: string): Promise<number> {
  if (portfolioIdParam) return Number(portfolioIdParam);
  const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows.length) throw new ValidationError('No portfolio found');
  return (rows[0] as any).id;
}

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const sp = req.nextUrl.searchParams;
  const portfolioId = await resolveUserPortfolioId(user.id, sp.get('portfolioId'));
  if (portfolioId == null) return { data: null, hasPortfolio: false };

  const action = sp.get('action');
  const asOf = sp.get('asOf') ?? undefined;

  if (action === 'validate') {
    const validation = await validateLedgerConsistency(portfolioId);
    return { data: validation, hasPortfolio: true };
  }

  if (action === 'prove') {
    const proof = await proveLedgerDeterminism(portfolioId);
    return { data: proof, hasPortfolio: true };
  }

  // Default: rebuild + valuate
  const state = await rebuildPortfolioState(portfolioId, asOf);
  const valuation = await valuatePortfolioState(state);
  return { data: valuation, hasPortfolio: true };
});

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json().catch(() => ({}));
  const portfolioId = await resolvePortfolio(user.id, body.portfolioId);

  const result = await syncSnapshotFromLedger(portfolioId);
  return { data: result, message: `Synced ${result.synced} positions, removed ${result.removed} stale entries` };
});
