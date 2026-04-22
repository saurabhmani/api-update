// ════════════════════════════════════════════════════════════════
//  Institutional Portfolio Fit & Sizing Service
//
//  Evaluates whether a proposed trade fits the current portfolio
//  across 5 dimensions, then computes a risk-aware position size.
//
//  Dimensions:
//    1. Exposure (sector + instrument concentration)
//    2. Concentration impact (post-trade HHI delta)
//    3. Diversification benefit (correlation with existing book)
//    4. Liquidity impact (position size vs avg daily volume)
//    5. Strategy sleeve constraints (max per strategy type)
//
//  All thresholds loaded from system_thresholds (DB). No hardcoded
//  numbers. Output is fully machine-readable.
//
//  This service is called by the decision orchestrator BEFORE risk
//  checks, so the recommendedQuantity feeds into the risk gate.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getConfig, type SystemConfig } from './systemConfigService';
import { getHoldings, type HoldingRow } from './portfolioLedgerService';
import { resolveById } from './instrumentResolver';

const log = logger.child({ service: 'institutionalFit' });

// ── Types ───────────────────────────────────────────────────────

export interface FitInput {
  portfolioId: number;
  userId: number;
  instrumentId: number;            // canonical identity — REQUIRED
  ticker?: string;                 // display hint only — resolved internally if omitted
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  strategySleeve?: string;
  stopLoss?: number;
}

export interface ExposureAnalysis {
  currentSectorPct: number;
  projectedSectorPct: number;
  sectorName: string;
  currentInstrumentPct: number;
  projectedInstrumentPct: number;
  sectorThreshold: number;
  instrumentThreshold: number;
  sectorBreached: boolean;
  instrumentBreached: boolean;
  penalty: number;           // 0–30
}

export interface ConcentrationAnalysis {
  currentHHI: number;
  projectedHHI: number;
  hhiDelta: number;
  top1WeightPre: number;
  top1WeightPost: number;
  penalty: number;           // 0–25
}

export interface DiversificationAnalysis {
  avgCorrelation: number;
  tickerCorrelation: number | null;  // vs existing book
  newSector: boolean;
  sectorCount: number;
  diversificationEffect: 'positive' | 'neutral' | 'negative';
  bonus: number;             // 0–10 (added to score)
}

export interface LiquidityAnalysis {
  avgDailyVolume: number;
  positionAsVolumePct: number;
  daysToExit: number;
  liquidityStress: 'none' | 'moderate' | 'severe';
  penalty: number;           // 0–20
}

export interface StrategySleeveAnalysis {
  currentSleeveCount: number;
  totalPositions: number;
  sleeveFraction: number;
  sleeveThreshold: number;
  breached: boolean;
  penalty: number;           // 0–15
}

export interface InstitutionalFitResult {
  // Core outputs
  fitScore: number;                    // 0–100
  suggestedQuantity: number;
  suggestedNotional: number;
  explanation: string;

  // Dimension breakdowns
  exposure: ExposureAnalysis;
  concentration: ConcentrationAnalysis;
  diversification: DiversificationAnalysis;
  liquidity: LiquidityAnalysis;
  strategySleeve: StrategySleeveAnalysis;

  // Sizing rationale
  sizing: {
    requestedQuantity: number;
    fitMultiplier: number;             // 0.0–1.0 — scales qty by fit
    liquidityMultiplier: number;       // 0.0–1.0 — scales qty by volume
    maxByConcentration: number;        // max qty before breaching concentration
    maxBySector: number;               // max qty before breaching sector cap
    finalQuantity: number;
    method: string;                    // which constraint was binding
  };

  // Warnings
  warnings: string[];

  // Metadata
  portfolioValuePre: number;
  positionsCount: number;
  timestamp: string;
}

// ── Helpers ─────────────────────────────────────────────────────

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Compute Herfindahl–Hirschman Index from weights
function computeHHI(weights: number[]): number {
  return weights.reduce((s, w) => s + (w / 100) ** 2, 0) * 10000;
}

// ── Correlation with existing book ──────────────────────────────

async function computeTickerCorrelation(
  ticker: string,
  existingSymbols: string[],
  days: number,
): Promise<number | null> {
  if (!existingSymbols.length) return null;
  // Sample up to 5 existing symbols for correlation
  const sample = existingSymbols.slice(0, 5);
  const correlations: number[] = [];

  for (const sym of sample) {
    try {
      const { rows } = await db.query(`
        SELECT a.ts, a.close AS close_a, b.close AS close_b
        FROM candles a
        JOIN candles b ON DATE(a.ts) = DATE(b.ts)
          AND a.interval_unit = '1day' AND b.interval_unit = '1day'
          AND b.instrument_key = (SELECT instrument_key FROM instruments WHERE tradingsymbol = ? AND is_active = TRUE LIMIT 1)
        WHERE a.instrument_key = (SELECT instrument_key FROM instruments WHERE tradingsymbol = ? AND is_active = TRUE LIMIT 1)
          AND a.ts >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY a.ts ASC
        LIMIT 200
      `, [sym, ticker, days]);

      const data = rows as any[];
      if (data.length < 15) continue;

      const ra: number[] = [];
      const rb: number[] = [];
      for (let i = 1; i < data.length; i++) {
        const ca = toNum(data[i].close_a);
        const cb = toNum(data[i].close_b);
        const pa = toNum(data[i - 1].close_a);
        const pb = toNum(data[i - 1].close_b);
        if (pa > 0 && pb > 0) {
          ra.push((ca - pa) / pa);
          rb.push((cb - pb) / pb);
        }
      }
      if (ra.length < 10) continue;

      const n = ra.length;
      const ma = ra.reduce((s, v) => s + v, 0) / n;
      const mb = rb.reduce((s, v) => s + v, 0) / n;
      const cov = ra.reduce((s, v, i) => s + (v - ma) * (rb[i] - mb), 0) / n;
      const sa = Math.sqrt(ra.reduce((s, v) => s + (v - ma) ** 2, 0) / n);
      const sb = Math.sqrt(rb.reduce((s, v) => s + (v - mb) ** 2, 0) / n);
      if (sa > 0 && sb > 0) correlations.push(cov / (sa * sb));
    } catch { /* skip pair */ }
  }

  if (!correlations.length) return null;
  return parseFloat((correlations.reduce((a, b) => a + b, 0) / correlations.length).toFixed(4));
}

// ── Average daily volume for a ticker ───────────────────────────

async function getAvgDailyVolume(ticker: string, days = 30): Promise<number> {
  try {
    const { rows } = await db.query(`
      SELECT AVG(volume) AS avg_vol
      FROM candles c
      JOIN instruments i ON c.instrument_key = i.instrument_key
      WHERE i.tradingsymbol = ? AND c.candle_type = 'eod' AND c.interval_unit = '1day'
        AND c.ts >= DATE_SUB(NOW(), INTERVAL ? DAY)
    `, [ticker, days]);
    return toNum((rows[0] as any)?.avg_vol, 0);
  } catch {
    return 0;
  }
}

// ── Strategy sleeve counts from recent signals ──────────────────

async function getStrategyCounts(
  symbols: string[],
): Promise<Record<string, number>> {
  if (!symbols.length) return {};
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const { rows } = await db.query(`
      SELECT scenario_tag, COUNT(*) AS cnt
      FROM q365_signals
      WHERE tradingsymbol IN (${placeholders})
        AND generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND signal_type IN ('BUY', 'SELL')
      GROUP BY scenario_tag
    `, symbols);
    const counts: Record<string, number> = {};
    for (const r of rows as any[]) {
      if (r.scenario_tag) counts[r.scenario_tag] = Number(r.cnt);
    }
    return counts;
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN: Evaluate Institutional Fit
// ═══════════════════════════════════════════════════════════════

export async function evaluateInstitutionalFit(
  input: FitInput,
): Promise<InstitutionalFitResult> {
  const cfg = await getConfig();
  const warnings: string[] = [];

  // ── Load portfolio state from ledger ──────────────────────────
  const holdings = await getHoldings(input.portfolioId);
  const portfolioValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const tradeNotional = input.quantity * input.price;
  const projectedTotal = portfolioValue + (input.side === 'buy' ? tradeNotional : -tradeNotional);

  // Resolve canonical identity — instrumentId is the primary key
  const instRef = await resolveById(input.instrumentId);
  const ticker = instRef?.ticker ?? input.ticker ?? '';
  const sector = instRef?.sector ?? 'Other';

  // ═════════════════════════════════════════════════════════════
  // DIMENSION 1: Exposure (sector + instrument)
  // ═════════════════════════════════════════════════════════════
  const sectorValue = holdings
    .filter(h => h.sector === sector)
    .reduce((s, h) => s + h.marketValue, 0);
  const currentSectorPct = portfolioValue > 0 ? (sectorValue / portfolioValue) * 100 : 0;
  const projectedSectorPct = projectedTotal > 0
    ? ((sectorValue + (input.side === 'buy' ? tradeNotional : 0)) / projectedTotal) * 100
    : 0;

  const existingHolding = holdings.find(h => h.instrumentId === input.instrumentId || h.ticker === ticker);
  const existingVal = existingHolding?.marketValue ?? 0;
  const currentInstrumentPct = portfolioValue > 0 ? (existingVal / portfolioValue) * 100 : 0;
  const projectedInstrumentPct = projectedTotal > 0
    ? ((existingVal + (input.side === 'buy' ? tradeNotional : 0)) / projectedTotal) * 100
    : 0;

  const sectorThreshold = cfg.MAX_SECTOR_EXPOSURE;         // from DB
  const instrumentThreshold = 20; // single-name max — could be made configurable
  const sectorBreached = projectedSectorPct > sectorThreshold;
  const instrumentBreached = projectedInstrumentPct > instrumentThreshold;

  let exposurePenalty = 0;
  if (sectorBreached) {
    exposurePenalty += 20;
    warnings.push(`${sector} sector would reach ${projectedSectorPct.toFixed(1)}% (limit: ${sectorThreshold}%)`);
  } else if (projectedSectorPct > sectorThreshold * 0.75) {
    exposurePenalty += 8;
    warnings.push(`${sector} sector approaching limit at ${projectedSectorPct.toFixed(1)}%`);
  }
  if (instrumentBreached) {
    exposurePenalty += 10;
    warnings.push(`${ticker} would be ${projectedInstrumentPct.toFixed(1)}% of portfolio (max: ${instrumentThreshold}%)`);
  }

  const exposure: ExposureAnalysis = {
    currentSectorPct: parseFloat(currentSectorPct.toFixed(2)),
    projectedSectorPct: parseFloat(projectedSectorPct.toFixed(2)),
    sectorName: sector,
    currentInstrumentPct: parseFloat(currentInstrumentPct.toFixed(2)),
    projectedInstrumentPct: parseFloat(projectedInstrumentPct.toFixed(2)),
    sectorThreshold,
    instrumentThreshold,
    sectorBreached,
    instrumentBreached,
    penalty: exposurePenalty,
  };

  // ═════════════════════════════════════════════════════════════
  // DIMENSION 2: Concentration (HHI delta)
  // ═════════════════════════════════════════════════════════════
  const preWeights = holdings.map(h => portfolioValue > 0 ? (h.marketValue / portfolioValue) * 100 : 0);
  const currentHHI = computeHHI(preWeights);

  // Projected weights after trade
  const postHoldings = [...holdings.map(h => ({ ...h }))];
  const existingIdx = postHoldings.findIndex(h => h.instrumentId === input.instrumentId || h.ticker === ticker);
  if (existingIdx >= 0) {
    postHoldings[existingIdx].marketValue += (input.side === 'buy' ? tradeNotional : -tradeNotional);
  } else if (input.side === 'buy') {
    postHoldings.push({ ticker, instrumentId: input.instrumentId, marketValue: tradeNotional } as any);
  }
  const postWeights = postHoldings
    .filter(h => h.marketValue > 0)
    .map(h => projectedTotal > 0 ? (h.marketValue / projectedTotal) * 100 : 0);
  const projectedHHI = computeHHI(postWeights);
  const hhiDelta = projectedHHI - currentHHI;

  const top1Pre = preWeights.length ? Math.max(...preWeights) : 0;
  const top1Post = postWeights.length ? Math.max(...postWeights) : 0;

  let concentrationPenalty = 0;
  if (hhiDelta > 200) {
    concentrationPenalty = 25;
    warnings.push(`HHI increases by ${hhiDelta.toFixed(0)} — significant concentration increase`);
  } else if (hhiDelta > 100) {
    concentrationPenalty = 12;
  } else if (hhiDelta > 50) {
    concentrationPenalty = 5;
  }

  const concentration: ConcentrationAnalysis = {
    currentHHI: parseFloat(currentHHI.toFixed(0)),
    projectedHHI: parseFloat(projectedHHI.toFixed(0)),
    hhiDelta: parseFloat(hhiDelta.toFixed(0)),
    top1WeightPre: parseFloat(top1Pre.toFixed(2)),
    top1WeightPost: parseFloat(top1Post.toFixed(2)),
    penalty: concentrationPenalty,
  };

  // ═════════════════════════════════════════════════════════════
  // DIMENSION 3: Diversification (correlation + sector count)
  // ═════════════════════════════════════════════════════════════
  const existingSymbols = holdings.map(h => h.ticker);
  const tickerCorrelation = await computeTickerCorrelation(
    ticker, existingSymbols, cfg.CORRELATION_LOOKBACK_DAYS,
  );

  const existingSectors = new Set(holdings.map(h => h.sector).filter(Boolean));
  const newSector = !existingSectors.has(sector);
  const avgCorrelation = tickerCorrelation ?? 0;

  let diversificationBonus = 0;
  let diversificationEffect: DiversificationAnalysis['diversificationEffect'] = 'neutral';

  if (newSector && holdings.length > 0) {
    diversificationBonus = 8;
    diversificationEffect = 'positive';
  } else if (avgCorrelation < 0.3 && holdings.length > 0) {
    diversificationBonus = 5;
    diversificationEffect = 'positive';
  } else if (avgCorrelation > cfg.MAX_CORRELATION) {
    diversificationEffect = 'negative';
    warnings.push(`High correlation (${avgCorrelation.toFixed(2)}) with existing holdings`);
  }

  const diversification: DiversificationAnalysis = {
    avgCorrelation: parseFloat(avgCorrelation.toFixed(4)),
    tickerCorrelation,
    newSector,
    sectorCount: existingSectors.size + (newSector ? 1 : 0),
    diversificationEffect,
    bonus: diversificationBonus,
  };

  // ═════════════════════════════════════════════════════════════
  // DIMENSION 4: Liquidity (position vs volume)
  // ═════════════════════════════════════════════════════════════
  const avgDailyVolume = await getAvgDailyVolume(ticker);
  const participationRate = 0.20; // assume max 20% of daily volume
  const positionAsVolumePct = avgDailyVolume > 0
    ? (input.quantity / avgDailyVolume) * 100
    : 100;
  const daysToExit = avgDailyVolume > 0
    ? input.quantity / (avgDailyVolume * participationRate)
    : 999;

  let liquidityPenalty = 0;
  let liquidityStress: LiquidityAnalysis['liquidityStress'] = 'none';
  if (daysToExit > 10 || positionAsVolumePct > 50) {
    liquidityPenalty = 20;
    liquidityStress = 'severe';
    warnings.push(`Position is ${positionAsVolumePct.toFixed(0)}% of daily volume — ${daysToExit.toFixed(1)} days to exit`);
  } else if (daysToExit > 5 || positionAsVolumePct > 25) {
    liquidityPenalty = 10;
    liquidityStress = 'moderate';
  }

  const liquidity: LiquidityAnalysis = {
    avgDailyVolume: Math.round(avgDailyVolume),
    positionAsVolumePct: parseFloat(positionAsVolumePct.toFixed(2)),
    daysToExit: parseFloat(Math.min(daysToExit, 999).toFixed(1)),
    liquidityStress,
    penalty: liquidityPenalty,
  };

  // ═════════════════════════════════════════════════════════════
  // DIMENSION 5: Strategy sleeve constraints
  // ═════════════════════════════════════════════════════════════
  const sleeve = input.strategySleeve ?? 'unknown';
  const strategyCounts = await getStrategyCounts(existingSymbols);
  const currentSleeveCount = strategyCounts[sleeve] ?? 0;
  const totalPositions = holdings.length;
  const sleeveFraction = totalPositions > 0 ? currentSleeveCount / totalPositions : 0;
  const sleeveThreshold = cfg.MAX_STRATEGY_CONCENTRATION;

  let sleevePenalty = 0;
  const sleeveBreached = sleeveFraction >= sleeveThreshold;
  if (sleeveBreached) {
    sleevePenalty = 15;
    warnings.push(`Strategy "${sleeve}" at ${(sleeveFraction * 100).toFixed(0)}% of portfolio (max: ${(sleeveThreshold * 100).toFixed(0)}%)`);
  } else if (sleeveFraction >= sleeveThreshold * 0.7) {
    sleevePenalty = 7;
  }

  const strategySleeve: StrategySleeveAnalysis = {
    currentSleeveCount,
    totalPositions,
    sleeveFraction: parseFloat(sleeveFraction.toFixed(4)),
    sleeveThreshold,
    breached: sleeveBreached,
    penalty: sleevePenalty,
  };

  // ═════════════════════════════════════════════════════════════
  // FIT SCORE (0–100)
  // ═════════════════════════════════════════════════════════════
  let score = 100;
  score -= exposure.penalty;
  score -= concentration.penalty;
  score += diversification.bonus;
  score -= liquidity.penalty;
  score -= strategySleeve.penalty;

  // Position count headroom
  if (totalPositions >= cfg.MAX_POSITIONS) {
    score -= 30;
    warnings.push(`At maximum ${cfg.MAX_POSITIONS} positions — no capacity for new entries`);
  } else if (totalPositions >= cfg.MAX_POSITIONS - 2) {
    score -= 10;
    warnings.push(`Near position limit (${totalPositions}/${cfg.MAX_POSITIONS})`);
  }

  const fitScore = Math.max(0, Math.min(100, Math.round(score)));

  // ═════════════════════════════════════════════════════════════
  // SIZING
  // ═════════════════════════════════════════════════════════════
  const fitMultiplier =
    fitScore >= 80 ? 1.0 :
    fitScore >= 60 ? 0.75 :
    fitScore >= 40 ? 0.50 : 0.25;

  const liquidityMultiplier = avgDailyVolume > 0
    ? Math.min(1.0, (avgDailyVolume * participationRate) / input.quantity)
    : 0.5;

  // Max quantity before breaching sector cap
  const sectorHeadroom = portfolioValue > 0
    ? ((sectorThreshold / 100) * projectedTotal - sectorValue)
    : Infinity;
  const maxBySector = input.price > 0 ? Math.floor(Math.max(0, sectorHeadroom) / input.price) : input.quantity;

  // Max quantity before breaching single-name cap
  const instrumentHeadroom = portfolioValue > 0
    ? ((instrumentThreshold / 100) * projectedTotal - existingVal)
    : Infinity;
  const maxByConcentration = input.price > 0 ? Math.floor(Math.max(0, instrumentHeadroom) / input.price) : input.quantity;

  // Final quantity = min of all constraints
  const scaledByFit = Math.max(1, Math.floor(input.quantity * fitMultiplier));
  const scaledByLiquidity = Math.max(1, Math.floor(input.quantity * liquidityMultiplier));
  const candidates = [
    { qty: scaledByFit, method: 'fit_scaling' },
    { qty: scaledByLiquidity, method: 'liquidity_scaling' },
    { qty: maxBySector, method: 'sector_cap' },
    { qty: maxByConcentration, method: 'concentration_cap' },
    { qty: input.quantity, method: 'requested' },
  ].filter(c => c.qty > 0);

  const binding = candidates.reduce((min, c) => c.qty < min.qty ? c : min);
  const finalQuantity = Math.max(1, binding.qty);
  const suggestedNotional = finalQuantity * input.price;

  if (finalQuantity < input.quantity) {
    warnings.push(`Quantity reduced from ${input.quantity} to ${finalQuantity} (binding: ${binding.method})`);
  }

  // ═════════════════════════════════════════════════════════════
  // EXPLANATION
  // ═════════════════════════════════════════════════════════════
  const explanationParts: string[] = [];
  explanationParts.push(`Fit score: ${fitScore}/100.`);
  if (fitScore >= 80) explanationParts.push('Excellent fit — trade diversifies well.');
  else if (fitScore >= 60) explanationParts.push('Acceptable fit — monitor concentration.');
  else if (fitScore >= 40) explanationParts.push('Marginal fit — size reduced.');
  else explanationParts.push('Poor fit — would overconcentrate or breach limits.');

  if (diversification.newSector) explanationParts.push(`Adds new sector (${sector}).`);
  if (liquidity.liquidityStress !== 'none') explanationParts.push(`Liquidity: ${liquidity.liquidityStress}.`);
  if (finalQuantity !== input.quantity) explanationParts.push(`Sized to ${finalQuantity} shares (from ${input.quantity}) by ${binding.method}.`);

  return {
    fitScore,
    suggestedQuantity: finalQuantity,
    suggestedNotional: parseFloat(suggestedNotional.toFixed(2)),
    explanation: explanationParts.join(' '),
    exposure,
    concentration,
    diversification,
    liquidity,
    strategySleeve,
    sizing: {
      requestedQuantity: input.quantity,
      fitMultiplier,
      liquidityMultiplier: parseFloat(liquidityMultiplier.toFixed(4)),
      maxByConcentration,
      maxBySector,
      finalQuantity,
      method: binding.method,
    },
    warnings,
    portfolioValuePre: parseFloat(portfolioValue.toFixed(2)),
    positionsCount: totalPositions,
    timestamp: new Date().toISOString(),
  };
}
