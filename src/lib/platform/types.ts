// ════════════════════════════════════════════════════════════════
//  Phase 6 — Multi-Asset Platform Types
// ════════════════════════════════════════════════════════════════

export const MULTI_ASSET_SCHEMA_VERSION = '6.0.0';

export type AssetClass =
  | 'equity'
  | 'index'
  | 'etf'
  | 'futures'
  | 'options'
  | 'forex'
  | 'crypto'
  | 'commodity';

export type MarketSessionType = 'pre_market' | 'regular' | 'post_market' | 'twenty_four_seven';

export type StrategyFamily =
  | 'breakout'
  | 'trend_following'
  | 'momentum'
  | 'mean_reversion'
  | 'reversal'
  | 'volatility'
  | 'structure'
  | 'confirmation';

export interface TradingSessionWindow {
  type: MarketSessionType;
  open: string;
  close: string;
}

export interface TradingCalendar {
  timezone: string;
  weekends: number[];
  holidays: string[];
  sessions: TradingSessionWindow[];
}

export interface AssetDefinition {
  assetId: string;
  assetClass: AssetClass;
  symbol: string;
  exchange: string;
  currency: string;
  tickSize: number;
  lotSize: number;
  pricePrecision: number;
  timezone: string;
  calendar: TradingCalendar;
  region: string;
  metadataOnly?: boolean;
}

export interface StrategyDefinition {
  strategyId: string;
  version: string;
  displayName: string;
  family: StrategyFamily;
  supportedAssets: AssetClass[];
  requiredFeatures: string[];
  allowedRegimes: string[];
  minimumHistoryBars: number;
  riskProfile: string;
  entryType: string;
  exitType: string;
  metadataOnly?: boolean;
}

export interface MultiAssetRiskProfile {
  assetClass: AssetClass;
  tickValue: number;
  atrMultiplierDefault: number;
  slippageBps: number;
  feePerTrade: number;
  spreadEstimateBps: number;
  currency: string;
  conversionRateToBase: number;
}

export interface PortfolioContextReport {
  generatedAt: string;
  sectorExposure: Record<string, number>;
  assetExposure: Record<string, number>;
  correlationSummary: Array<{ pair: string; correlation: number }>;
  concentrationScore: number;
  allocationSummary: Record<string, number>;
}

export interface MultiAssetConfigOverlay {
  assetClass?: AssetClass;
  strategyId?: string;
  minAvgVolume?: number;
  minPrice?: number;
  minRewardRisk?: number;
  slippageBps?: number;
}

export interface ResolvedMultiAssetConfig {
  version: string;
  baseVersion: string;
  assetClass: AssetClass;
  overlays: MultiAssetConfigOverlay[];
  effective: Record<string, number>;
}
