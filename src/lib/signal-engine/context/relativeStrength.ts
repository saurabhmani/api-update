// ════════════════════════════════════════════════════════════════
//  Relative Strength Engine — Phase 2
//
//  Multi-period relative strength: 5-day and 20-day RS vs index
//  and sector. Includes RS trend detection (improving/deteriorating).
// ════════════════════════════════════════════════════════════════

import type {
  Candle, RelativeStrengthFeatures, EnhancedRelativeStrength,
  SectorTrendLabel,
} from '../types/signalEngine.types';
import { closes } from '../utils/candles';
import { round, safeDivide } from '../utils/math';

// ── Basic RS (backward compatible) ─────────────────────────
export function computeRelativeStrength(
  stockCandles: Candle[],
  indexCandles: Candle[],
  sectorCandles?: Candle[],
): RelativeStrengthFeatures {
  const stockCloses = closes(stockCandles);
  const indexCloses = closes(indexCandles);
  const sectorCloses = sectorCandles ? closes(sectorCandles) : null;

  const stockReturn = computeReturn(stockCloses, 5);
  const indexReturn = computeReturn(indexCloses, 5);
  const sectorReturn = sectorCloses ? computeReturn(sectorCloses, 5) : indexReturn;

  const rsVsIndex = round(stockReturn - indexReturn);
  const rsVsSector = round(stockReturn - sectorReturn);
  const sectorStrengthScore = round(mapReturnToScore(sectorReturn));

  return { rsVsIndex, rsVsSector, sectorStrengthScore };
}

// ── Enhanced multi-period RS (Phase 2) ─────────────────────
export function computeEnhancedRelativeStrength(
  stockCandles: Candle[],
  indexCandles: Candle[],
  sectorCandles?: Candle[],
  sectorTrendLabel: SectorTrendLabel = 'Neutral',
): EnhancedRelativeStrength {
  const stockCloses = closes(stockCandles);
  const indexCloses = closes(indexCandles);
  const sectorCloses = sectorCandles ? closes(sectorCandles) : null;

  // 5-day returns
  const stockReturn5 = computeReturn(stockCloses, 5);
  const indexReturn5 = computeReturn(indexCloses, 5);
  const sectorReturn5 = sectorCloses ? computeReturn(sectorCloses, 5) : indexReturn5;

  // 20-day returns
  const stockReturn20 = computeReturn(stockCloses, 20);
  const indexReturn20 = computeReturn(indexCloses, 20);
  const sectorReturn20 = sectorCloses ? computeReturn(sectorCloses, 20) : indexReturn20;

  const rsVsIndex5d = round(stockReturn5 - indexReturn5);
  const rsVsIndex20d = round(stockReturn20 - indexReturn20);
  const rsVsSector5d = round(stockReturn5 - sectorReturn5);
  const rsVsSector20d = round(stockReturn20 - sectorReturn20);

  // RS trend: compare short-term RS vs medium-term RS
  // If 5d RS > 20d RS: stock is accelerating relative to index → improving
  const rsDelta = rsVsIndex5d - rsVsIndex20d;
  const rsTrend: EnhancedRelativeStrength['rsTrend'] =
    rsDelta > 1.5 ? 'improving' :
    rsDelta < -1.5 ? 'deteriorating' :
    'stable';

  // Backward-compatible fields
  const sectorStrengthScore = round(mapReturnToScore(sectorReturn5));

  return {
    // Base RelativeStrengthFeatures fields
    rsVsIndex: rsVsIndex5d,
    rsVsSector: rsVsSector5d,
    sectorStrengthScore,

    // Enhanced fields
    rsVsIndex5d,
    rsVsIndex20d,
    rsVsSector5d,
    rsVsSector20d,
    rsTrend,
    sectorTrendLabel,
  };
}

function computeReturn(closes: number[], period: number): number {
  const len = closes.length;
  if (len <= period) return 0;
  return safeDivide(closes[len - 1] - closes[len - 1 - period], closes[len - 1 - period]) * 100;
}

// Map a 5-day return to a 0-100 score
// -5% → 0, 0% → 50, +5% → 100
function mapReturnToScore(returnPct: number): number {
  return Math.max(0, Math.min(100, 50 + returnPct * 10));
}

// Default RS when no index/sector candles available
export function defaultRelativeStrength(): RelativeStrengthFeatures {
  return { rsVsIndex: 0, rsVsSector: 0, sectorStrengthScore: 50 };
}

export function defaultEnhancedRelativeStrength(): EnhancedRelativeStrength {
  return {
    rsVsIndex: 0, rsVsSector: 0, sectorStrengthScore: 50,
    rsVsIndex5d: 0, rsVsIndex20d: 0,
    rsVsSector5d: 0, rsVsSector20d: 0,
    rsTrend: 'stable',
    sectorTrendLabel: 'Neutral',
  };
}
