// POST /api/portfolio-fit/size-trade — Portfolio-aware trade sizing
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getPortfolioContext, computePortfolioFit } from '@/services/portfolioFitService';
import { computeExposure } from '@/services/riskCoreService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const { ticker, price, stopLoss, strategy, riskPerTrade } = body;

  if (!ticker || !price) throw new ValidationError('ticker and price are required');

  const tickerUp = ticker.toUpperCase();
  const entryPrice = Number(price);
  const stop = stopLoss ? Number(stopLoss) : entryPrice * 0.95; // default 5% stop
  const riskPct = riskPerTrade ? Number(riskPerTrade) : 1.5;    // default 1.5% risk per trade

  // Resolve sector & portfolio
  const { rows: instRows } = await db.query(
    'SELECT sector FROM instruments WHERE tradingsymbol = ? LIMIT 1',
    [tickerUp],
  );
  const sector = (instRows[0] as any)?.sector ?? 'Other';

  const { rows: pRows } = await db.query(
    'SELECT id FROM portfolios WHERE user_id = ? LIMIT 1',
    [user.id],
  );
  if (!pRows.length) throw new ValidationError('No portfolio found');
  const portfolioId = (pRows[0] as any).id;

  // Get portfolio state
  const [ctx, exposure] = await Promise.all([
    getPortfolioContext(user.id),
    computeExposure(portfolioId),
  ]);

  const portfolioValue = exposure.grossExposure || 100000; // fallback
  const fit = computePortfolioFit(ctx, sector, strategy ?? 'swing', 'BUY');

  // Risk-based position sizing
  const riskPerShare = Math.abs(entryPrice - stop);
  if (riskPerShare <= 0) throw new ValidationError('stopLoss must differ from price');

  const maxRiskAmount = portfolioValue * (riskPct / 100);
  let suggestedQty = Math.floor(maxRiskAmount / riskPerShare);

  // Apply fit-based scaling
  const fitMultiplier = fit.portfolio_fit_score >= 80 ? 1.0 :
    fit.portfolio_fit_score >= 60 ? 0.75 :
    fit.portfolio_fit_score >= 40 ? 0.5 : 0.25;
  suggestedQty = Math.max(1, Math.floor(suggestedQty * fitMultiplier));

  // Cap at max single position size (20%)
  const maxNotional = portfolioValue * 0.20;
  const maxQtyByCap = Math.floor(maxNotional / entryPrice);
  suggestedQty = Math.min(suggestedQty, maxQtyByCap);

  const suggestedNotional = suggestedQty * entryPrice;
  const concentrationImpact = portfolioValue > 0
    ? parseFloat(((suggestedNotional / (portfolioValue + suggestedNotional)) * 100).toFixed(2))
    : 0;

  // Diversification effect
  const currentSectorPct = ctx.sector_exposure_pct[sector] ?? 0;
  const postSectorPct = currentSectorPct + concentrationImpact;
  const diversificationEffect = postSectorPct < 20 ? 'positive' :
    postSectorPct < 30 ? 'neutral' : 'negative';

  return {
    data: {
      ticker: tickerUp,
      suggestedQuantity: suggestedQty,
      suggestedNotional: parseFloat(suggestedNotional.toFixed(2)),
      entryPrice,
      stopLoss: stop,
      riskPerShare: parseFloat(riskPerShare.toFixed(2)),
      riskAmount: parseFloat((suggestedQty * riskPerShare).toFixed(2)),
      fitScore: fit.portfolio_fit_score,
      fitMultiplier,
      concentrationImpact,
      diversificationEffect,
      explanation: `Sized at ${suggestedQty} shares (₹${suggestedNotional.toFixed(0)}) based on ${riskPct}% risk per trade, ${fit.portfolio_fit_score} fit score. ${fit.notes}`,
    },
  };
});
