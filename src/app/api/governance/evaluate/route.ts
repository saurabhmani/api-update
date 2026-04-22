// POST /api/governance/evaluate — Evaluate governance via full decision pipeline
//
// PRD RULE: There is ONE decision entry point.
// This route delegates to evaluateInstitutionalDecision() which runs
// the full 7-gate chain. The response is shaped to match the governance
// API contract for backward compatibility.
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { evaluateInstitutionalDecision } from '@/services/decisionOrchestrator';
import { resolve } from '@/services/instrumentResolver';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, side, quantity, price, strategySleeve } = body;

  if (!ticker || !side || !quantity || !price) {
    throw new ValidationError('ticker, side, quantity, and price are required');
  }

  // ── BOUNDARY: resolve ticker→instrumentId ────────────────────
  let resolvedInstrumentId = body.instrumentId ? Number(body.instrumentId) : 0;
  if (!resolvedInstrumentId) {
    const ref = await resolve(ticker);
    if (!ref) throw new ValidationError(`Unknown instrument: ${ticker}`);
    resolvedInstrumentId = ref.instrumentId;
  }

  let portfolioId = body.portfolioId;
  if (!portfolioId) {
    const { rows } = await db.query('SELECT id FROM portfolios WHERE user_id = ? LIMIT 1', [user.id]);
    if (!rows.length) throw new ValidationError('No portfolio found');
    portfolioId = (rows[0] as any).id;
  }

  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null;

  // ── DELEGATE to the single decision entry point ────────────
  const decision = await evaluateInstitutionalDecision({
    portfolioId,
    userId: user.id,
    ticker: ticker.toUpperCase(),
    instrumentId: resolvedInstrumentId,
    side,
    quantity: Number(quantity),
    price: Number(price),
    strategySleeve,
    ipAddress: ip ?? undefined,
  });

  // ── Shape response for governance API backward compat ────────
  return {
    data: {
      overallStatus: decision.governanceSnapshot?.overallStatus ?? 'unknown',
      results: decision.governanceSnapshot?.violations ?? [],
      timestamp: decision.timestamp,
      institutionalDecision: decision.decision,
      decisionId: decision.trace?.decisionId ?? null,
      gates: decision.gatesSummary,
    },
  };
});
