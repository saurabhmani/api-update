/**
 * Shared tick-layer types (compatible with former kite Tick shape).
 */

export interface TickData {
  symbol: string;
  /** Prefer ltp; lastPrice retained for legacy consumers. */
  ltp?: number;
  lastPrice?: number;
  timestamp?: number;
  ts?: number;
  volume?: number;
  change?: number;
  changePercent?: number;
  pChange?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  source?: string;
}

export type MarketState = 'live' | 'stale' | 'disconnected' | 'unauthenticated' | 'closed';

export interface MarketFreshness {
  state: MarketState;
  lastTickTs: number | null;
  ageMs: number | null;
  maxAgeMs: number;
  subscribedCount: number;
  ticksReceived: number;
  reason?: string;
}

export interface StrategyTickHint {
  symbol: string;
  ltp: number;
  asOfMs: number;
  stale: boolean;
}
