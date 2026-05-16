// POST /api/portfolio-fit/evaluate — Evaluate portfolio fit for a proposed trade
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getPortfolioContext, computePortfolioFit } from '@/services/portfolioFitService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, strategy, direction } = body;

  if (!ticker) throw new ValidationError('ticker is required');

  // Resolve sector
  const { rows: instRows } = await db.query(
    'SELECT sector FROM instruments WHERE tradingsymbol = ? LIMIT 1',
    [ticker.toUpperCase()],
  );
  const sector = (instRows[0] as any)?.sector ?? 'Other';

  const ctx = await getPortfolioContext(user.id);
  const fit = computePortfolioFit(
    ctx,
    sector,
    strategy ?? 'swing',
    direction ?? 'BUY',
  );

  return {
    data: {
      ticker: ticker.toUpperCase(),
      sector,
      fitScore: fit.portfolio_fit_score,
      sectorPenalty: fit.sector_penalty,
      correlationPenalty: fit.correlation_penalty,
      strategyPenalty: fit.strategy_penalty,
      drawdownPenalty: fit.drawdown_penalty,
      capacityScore: fit.capacity_score,
      warnings: fit.warnings,
      notes: fit.notes,
      portfolioContext: {
        totalPositions: ctx.total_positions,
        sectorExposure: ctx.sector_exposure_pct,
        drawdownPct: ctx.drawdown_pct,
        correlationAvg: ctx.correlation_avg,
      },
    },
  };
});
