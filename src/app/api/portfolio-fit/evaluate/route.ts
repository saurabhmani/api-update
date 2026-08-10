// POST /api/portfolio-fit/evaluate — Evaluate portfolio fit for a proposed trade
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getPortfolioContext, computePortfolioFit } from '@/services/portfolioFitService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, strategy, direction } = body;

  if (!ticker) throw new ValidationError('ticker is required');

  const symbol = String(ticker).toUpperCase().trim();

  // Resolve sector: instruments.sector → q365_universe.sector → SECTOR_MAP → Other
  let sector: string | null = null;
  let sectorSource: 'instruments' | 'q365_universe' | 'sector_map' | 'fallback' = 'fallback';

  const { rows: instRows } = await db.query(
    'SELECT sector FROM instruments WHERE tradingsymbol = ? LIMIT 1',
    [symbol],
  );
  const instSector = String((instRows[0] as any)?.sector ?? '').trim();
  if (instSector) {
    sector = instSector;
    sectorSource = 'instruments';
  }

  if (!sector) {
    try {
      const { rows: uniRows } = await db.query(
        'SELECT sector FROM q365_universe WHERE symbol = ? LIMIT 1',
        [symbol],
      );
      const uniSector = String((uniRows[0] as any)?.sector ?? '').trim();
      if (uniSector) {
        sector = uniSector;
        sectorSource = 'q365_universe';
      }
    } catch { /* table/column may be missing */ }
  }

  if (!sector) {
    const mapped = getSector(symbol);
    if (mapped && mapped !== 'Other') {
      sector = mapped;
      sectorSource = 'sector_map';
    }
  }

  if (!sector) sector = 'Other';

  const ctx = await getPortfolioContext(user.id);
  const fit = computePortfolioFit(
    ctx,
    sector,
    strategy ?? 'swing',
    direction ?? 'BUY',
  );

  return {
    data: {
      ticker: symbol,
      sector,
      sectorSource,
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
      emptyPortfolio: ctx.total_positions === 0,
    },
  };
});
