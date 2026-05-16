// POST /api/portfolio-fit/institutional — Full 5-dimension institutional fit analysis
//
// BOUNDARY: ticker→instrumentId resolution happens here.
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { evaluateInstitutionalFit } from '@/services/institutionalFitService';
import { resolve } from '@/services/instrumentResolver';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, side, quantity, price, strategySleeve, stopLoss } = body;

  if (!ticker) throw new ValidationError('ticker is required');
  if (!quantity || quantity <= 0) throw new ValidationError('quantity must be positive');
  if (!price || price <= 0) throw new ValidationError('price must be positive');

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

  const result = await evaluateInstitutionalFit({
    portfolioId,
    userId: user.id,
    instrumentId: resolvedInstrumentId,
    ticker: ticker.toUpperCase(),
    side: side ?? 'buy',
    quantity: Number(quantity),
    price: Number(price),
    strategySleeve,
    stopLoss: stopLoss ? Number(stopLoss) : undefined,
  });

  return { data: result };
});
