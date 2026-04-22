// ════════════════════════════════════════════════════════════════
//  Phase 3 Constants — Trade Engine Configuration
// ════════════════════════════════════════════════════════════════

import type { Phase3Config } from '../types/phase3.types';

export const DEFAULT_PHASE3_CONFIG: Phase3Config = {
  defaultCapital:              1_000_000,
  riskPerTradePct:             0.5,    // 0.5% of capital per trade
  maxGrossExposurePct:         60,     // 60% max gross portfolio exposure
  maxSectorExposurePct:        25,     // 25% max per sector
  maxCorrelationClusterCount:  3,      // max 3 positions per correlated cluster
  maxApprovedPerRun:           15,     // max 15 new approvals per pipeline run (raised from 8)
  maxDirectionImbalancePct:    70,     // 70% max on one side (long or short)
  minRewardRisk:               1.2,    // minimum R:R to approve (Phase 3 internal floor)
  stopMaxWidthPct:             8,      // reject if stop > 8% from entry
  target3RMultiple:            3.5,    // target3 = 3.5R
};

// Sector clustering map for Indian markets
export const SECTOR_MAP: Record<string, string> = {
  TCS: 'IT', INFY: 'IT', HCLTECH: 'IT', WIPRO: 'IT', TECHM: 'IT', MPHASIS: 'IT', LTM: 'IT',
  HDFCBANK: 'Banking', ICICIBANK: 'Banking', KOTAKBANK: 'Banking', AXISBANK: 'Banking',
  SBIN: 'Banking', INDUSINDBK: 'Banking', BANDHANBNK: 'Banking', BANKBARODA: 'Banking',
  RELIANCE: 'Conglomerate', ADANIENT: 'Conglomerate', ADANIPORTS: 'Infra',
  HINDUNILVR: 'FMCG', ITC: 'FMCG', NESTLEIND: 'FMCG', BRITANNIA: 'FMCG',
  DABUR: 'FMCG', GODREJCP: 'FMCG',
  BHARTIARTL: 'Telecom',
  LT: 'Infra', ULTRACEMCO: 'Cement', GRASIM: 'Cement',
  SUNPHARMA: 'Pharma', DRREDDY: 'Pharma', CIPLA: 'Pharma', DIVISLAB: 'Pharma', BIOCON: 'Pharma',
  TATAMOTORS: 'Auto', MARUTI: 'Auto', EICHERMOT: 'Auto', HEROMOTOCO: 'Auto', M_M: 'Auto',
  BAJFINANCE: 'NBFC', BAJAJFINSV: 'NBFC', SBILIFE: 'Insurance', HDFCLIFE: 'Insurance',
  TATASTEEL: 'Metals', JSWSTEEL: 'Metals', HINDALCO: 'Metals', VEDL: 'Metals', COALINDIA: 'Metals',
  NTPC: 'Power', POWERGRID: 'Power', ONGC: 'Energy', BPCL: 'Energy',
  TITAN: 'Consumer', ASIANPAINT: 'Consumer', PIDILITIND: 'Consumer',
  BERGEPAINT: 'Consumer', HAVELLS: 'Consumer',
  APOLLOHOSP: 'Healthcare', FORTIS: 'Healthcare',
};

export function getSector(symbol: string): string {
  return SECTOR_MAP[symbol.replace(/&/g, '_')] || 'Other';
}

/**
 * Bucket ATR% into a volatility regime label used for analytics
 * rollups. Boundaries chosen so Indian equities typically land in
 * 'normal': large-caps sit at ATR% 1–2.5, small-caps and event days
 * climb past 2.5. The 'extreme' bucket is the red flag for feedback
 * analytics.
 *
 * Shared between the live signal writer (saveSignals.ts) and the
 * backtest signal writer (saveBacktestSignals) so a strategy's
 * volatility state is labeled the same way in both pipelines.
 */
export function deriveVolatilityState(
  atrPct: number | null | undefined,
): string {
  if (atrPct == null || !Number.isFinite(atrPct) || atrPct <= 0) return 'unknown';
  if (atrPct < 1.0) return 'low';
  if (atrPct < 2.5) return 'normal';
  if (atrPct < 4.0) return 'elevated';
  return 'extreme';
}
