// POST /api/scenarios/evaluate-trade — Marginal scenario impact of a proposed trade
//
// BOUNDARY: ticker→instrumentId resolution happens here.
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { evaluateTradeScenario } from '@/services/scenarioStressService';
import { resolve } from '@/services/instrumentResolver';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { scenarioId, ticker, quantity, price } = body;

  if (!scenarioId || !ticker || !quantity || !price) {
    throw new ValidationError('scenarioId, ticker, quantity, and price are required');
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

  const result = await evaluateTradeScenario(portfolioId, scenarioId, {
    instrumentId: resolvedInstrumentId,
    ticker: ticker.toUpperCase(),
    quantity: Number(quantity),
    price: Number(price),
  });
  return { data: result };
});
