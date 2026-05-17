// ════════════════════════════════════════════════════════════════
//  Intraday / Confirmation Strategy Stubs (Phase 4B)
//
//  These detectors are wired into the strategy engine so the rest
//  of the platform (registry, performance, regime router) sees them
//  as first-class strategies. They CANNOT fire on the current EOD
//  candle warehouse — multi-timeframe alignment needs weekly + intraday
//  data, VWAP / opening-range strategies need intraday candles.
//
//  Honest contract: each detector returns
//    { matched: false, rejectionReason: 'INSUFFICIENT_DATA: ...' }
//
//  When the platform gains an intraday candle source, replace the
//  body with the real detector — no other file should need to change.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

function insufficient(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: `INSUFFICIENT_DATA: ${reason}` };
}

export function evaluateMultiTimeframeAlignment(_f: SignalFeatures): StrategyMatchResult {
  return insufficient('Multi-timeframe alignment requires weekly + intraday data that is not yet wired.');
}

export function evaluateVwapReclaimLong(_f: SignalFeatures): StrategyMatchResult {
  return insufficient('VWAP reclaim requires intraday candles that are not yet available on the EOD warehouse.');
}

export function evaluateVwapRejectionShort(_f: SignalFeatures): StrategyMatchResult {
  return insufficient('VWAP rejection requires intraday candles that are not yet available on the EOD warehouse.');
}

export function evaluateOpeningRangeBreakout(_f: SignalFeatures): StrategyMatchResult {
  return insufficient('Opening range breakout requires intraday candles that are not yet available on the EOD warehouse.');
}

export function evaluateOpeningRangeBreakdown(_f: SignalFeatures): StrategyMatchResult {
  return insufficient('Opening range breakdown requires intraday candles that are not yet available on the EOD warehouse.');
}
