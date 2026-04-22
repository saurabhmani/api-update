// ════════════════════════════════════════════════════════════════
//  POST /api/decisions/evaluate
//
//  THE institutional decision endpoint. Runs the full 6-gate
//  sequential pipeline:
//
//    1. Portfolio Context  → fit score, AUM, positions
//    2. Risk Checks        → breaches, limits, drawdown
//    3. Governance Checks  → policy, restrictions, turnover
//    4. Scenario Analysis   → stress impact under market drop
//    5. Explainability      → narrative, decisive factors
//    6. Audit               → persisted decision record
//
//  Every trade decision MUST go through this endpoint.
//  No shortcut. No bypass. No exception.
//
//  Input:
//    { ticker, side, quantity, price, portfolioId?, strategySleeve?, scenarioId? }
//
//  Output:
//    InstitutionalDecision with full gate trace
// ════════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { evaluateInstitutionalDecision, type DecisionInput } from '@/services/decisionOrchestrator';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, instrumentId, side, quantity, price, strategySleeve, scenarioId } = body;

  // ── Input validation ──────────────────────────────────────────
  // Accept either ticker OR instrumentId — resolver handles both
  if (!ticker && !instrumentId) {
    throw new ValidationError('ticker or instrumentId is required');
  }
  if (!side || !['buy', 'sell'].includes(side)) {
    throw new ValidationError('side must be "buy" or "sell"');
  }
  if (!quantity || typeof quantity !== 'number' || quantity <= 0) {
    throw new ValidationError('quantity must be a positive number');
  }
  if (!price || typeof price !== 'number' || price <= 0) {
    throw new ValidationError('price must be a positive number');
  }

  // ── Resolve portfolio ─────────────────────────────────────────
  let portfolioId = body.portfolioId;
  if (!portfolioId) {
    const { rows } = await db.query(
      'SELECT id FROM portfolios WHERE user_id = ? LIMIT 1',
      [user.id],
    );
    if (!rows.length) throw new ValidationError('No portfolio found for user');
    portfolioId = (rows[0] as any).id;
  }

  // ── Extract IP for audit ──────────────────────────────────────
  const ip = req.headers.get('x-forwarded-for')
    ?? req.headers.get('x-real-ip')
    ?? null;

  // ── Run the full 6-gate institutional decision pipeline ───────
  const input: DecisionInput = {
    portfolioId,
    userId: user.id,
    ticker: ticker ? ticker.toUpperCase() : '',
    instrumentId: instrumentId ? Number(instrumentId) : undefined,
    side,
    quantity: Number(quantity),
    price: Number(price),
    strategySleeve: strategySleeve ?? undefined,
    scenarioId: scenarioId ?? undefined,
    ipAddress: ip ?? undefined,
  };

  const decision = await evaluateInstitutionalDecision(input);

  return { data: decision };
});
