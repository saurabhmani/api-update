// Client-safe backtest defaults (no server/DB imports for webpack bundling)
import type { BacktestRunConfig } from '../types';

export const CLIENT_DEFAULT_BACKTEST_CONFIG: BacktestRunConfig = {
  name: 'Custom Backtest',
  universe: ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK'],
  benchmarkSymbol: 'NIFTY 50',
  startDate: '2024-06-01',
  endDate: '2026-03-31',
  warmupBars: 100,
  evaluationHorizon: 15,
  initialCapital: 1_000_000,
  riskPerTradePct: 0.5,
  maxGrossExposurePct: 60,
  maxSectorExposurePct: 25,
  minConfidence: 55,
  minRewardRisk: 1.2,
  maxStopWidthPct: 8,
  maxOpenPositions: 10,
  slippageBps: 10,
  commissionPerTrade: 20,
  feeModel: 'nse_delivery',
  positionSizingModel: 'risk_based',
  fixedPositionPct: 5,
  strategies: null,
  signalExpiryBars: 5,
  fillModel: 'conservative',
};
