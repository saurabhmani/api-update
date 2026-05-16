// ════════════════════════════════════════════════════════════════
//  Sector Context Engine — Phase 2
//
//  Computes sector strength, trend, and breadth from constituent
//  stock data. Provides sector-level context for signal scoring
//  and rejection decisions.
// ════════════════════════════════════════════════════════════════

import type { Candle, SectorContext, SectorTrendLabel } from '../types/signalEngine.types';
import { closes } from '../utils/candles';
import { round, safeDivide } from '../utils/math';
import { getSector, SECTOR_MAP } from '../constants/phase3.constants';

/**
 * Build sector context for a given symbol using available constituent data.
 *
 * @param symbol - The stock symbol
 * @param sectorCandles - Map of symbol → candles for sector constituents
 * @param benchmarkCandles - Benchmark candles for relative comparison
 */
export function buildSectorContext(
  symbol: string,
  sectorCandles: Map<string, Candle[]>,
  benchmarkCandles?: Candle[],
): SectorContext {
  const sector = getSector(symbol);

  // Find all symbols in the same sector
  const sectorSymbols = Object.entries(SECTOR_MAP)
    .filter(([, s]) => s === sector)
    .map(([sym]) => sym);

  // Compute sector aggregate returns from available data
  const returns5d: number[] = [];
  const returns20d: number[] = [];

  for (const sym of sectorSymbols) {
    const candles = sectorCandles.get(sym) ?? sectorCandles.get(sym.replace(/_/g, '&'));
    if (!candles || candles.length < 25) continue;

    const c = closes(candles);
    const len = c.length;

    if (len > 5) {
      returns5d.push(safeDivide(c[len - 1] - c[len - 6], c[len - 6]) * 100);
    }
    if (len > 20) {
      returns20d.push(safeDivide(c[len - 1] - c[len - 21], c[len - 21]) * 100);
    }
  }

  const sectorRoc5 = returns5d.length > 0
    ? round(returns5d.reduce((s, v) => s + v, 0) / returns5d.length)
    : 0;

  const sectorRoc20 = returns20d.length > 0
    ? round(returns20d.reduce((s, v) => s + v, 0) / returns20d.length)
    : 0;

  // Sector strength score: map combined returns to 0-100 scale
  // Short-term weighted 60%, medium-term 40%
  const compositeReturn = sectorRoc5 * 0.6 + sectorRoc20 * 0.4;
  const sectorStrengthScore = round(
    Math.max(0, Math.min(100, 50 + compositeReturn * 8)),
  );

  const sectorTrendLabel = classifySectorTrend(sectorRoc5, sectorRoc20, sectorStrengthScore);

  return {
    sector,
    sectorStrengthScore,
    sectorTrendLabel,
    sectorRoc5,
    sectorRoc20,
    stockCountInSector: sectorSymbols.length,
  };
}

/**
 * Build a lightweight sector context when only the symbol's own candles are available.
 * Uses the stock's own performance as a proxy for sector (less accurate but functional).
 */
export function buildSectorContextFromStock(
  symbol: string,
  stockCandles: Candle[],
  benchmarkCandles: Candle[],
): SectorContext {
  const sector = getSector(symbol);
  const stockCloses = closes(stockCandles);
  const benchCloses = closes(benchmarkCandles);
  const len = stockCloses.length;
  const bLen = benchCloses.length;

  // Stock returns
  const stockRoc5 = len > 5 ? safeDivide(stockCloses[len - 1] - stockCloses[len - 6], stockCloses[len - 6]) * 100 : 0;
  const stockRoc20 = len > 20 ? safeDivide(stockCloses[len - 1] - stockCloses[len - 21], stockCloses[len - 21]) * 100 : 0;

  // Benchmark returns
  const benchRoc5 = bLen > 5 ? safeDivide(benchCloses[bLen - 1] - benchCloses[bLen - 6], benchCloses[bLen - 6]) * 100 : 0;
  const benchRoc20 = bLen > 20 ? safeDivide(benchCloses[bLen - 1] - benchCloses[bLen - 21], benchCloses[bLen - 21]) * 100 : 0;

  // Use stock-vs-benchmark spread as sector proxy
  const sectorRoc5 = round(stockRoc5);
  const sectorRoc20 = round(stockRoc20);

  const compositeReturn = sectorRoc5 * 0.6 + sectorRoc20 * 0.4;
  const sectorStrengthScore = round(
    Math.max(0, Math.min(100, 50 + compositeReturn * 8)),
  );

  const sectorTrendLabel = classifySectorTrend(sectorRoc5, sectorRoc20, sectorStrengthScore);

  return {
    sector,
    sectorStrengthScore,
    sectorTrendLabel,
    sectorRoc5,
    sectorRoc20,
    stockCountInSector: Object.entries(SECTOR_MAP).filter(([, s]) => s === sector).length,
  };
}

function classifySectorTrend(
  roc5: number,
  roc20: number,
  strengthScore: number,
): SectorTrendLabel {
  if (strengthScore >= 75 && roc5 > 1 && roc20 > 2) return 'Strong';
  if (strengthScore >= 60 && roc5 > 0) return 'Positive';
  if (strengthScore >= 40) return 'Neutral';
  if (strengthScore >= 25) return 'Weak';
  return 'Declining';
}

/**
 * Default sector context when no data available.
 */
export function defaultSectorContext(symbol: string): SectorContext {
  return {
    sector: getSector(symbol),
    sectorStrengthScore: 50,
    sectorTrendLabel: 'Neutral',
    sectorRoc5: 0,
    sectorRoc20: 0,
    stockCountInSector: 0,
  };
}
