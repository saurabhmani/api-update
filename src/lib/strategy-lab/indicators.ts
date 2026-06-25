// Supported indicators catalog for Strategy Lab

import type { LabTimeframe, SupportedIndicator } from './types';

export interface IndicatorMeta {
  id: SupportedIndicator;
  label: string;
  category: 'momentum' | 'trend' | 'volume' | 'volatility' | 'regime';
  defaultOperator: string;
  valueHint: string;
  lookaheadSafe: boolean;
}

export const SUPPORTED_INDICATORS: IndicatorMeta[] = [
  { id: 'rsi', label: 'RSI', category: 'momentum', defaultOperator: 'between', valueHint: '40-70', lookaheadSafe: true },
  { id: 'ema_20', label: 'EMA 20', category: 'trend', defaultOperator: 'crosses_above', valueHint: 'ema_50', lookaheadSafe: true },
  { id: 'ema_50', label: 'EMA 50', category: 'trend', defaultOperator: 'gt', valueHint: 'price', lookaheadSafe: true },
  { id: 'adx', label: 'ADX', category: 'trend', defaultOperator: 'gte', valueHint: '20', lookaheadSafe: true },
  { id: 'volume_expansion', label: 'Volume Expansion', category: 'volume', defaultOperator: 'gte', valueHint: '1.5', lookaheadSafe: true },
  { id: 'close_vs_ema20', label: 'Close vs EMA20', category: 'trend', defaultOperator: 'gt', valueHint: '0', lookaheadSafe: true },
  { id: 'close_vs_ema50', label: 'Close vs EMA50', category: 'trend', defaultOperator: 'gt', valueHint: '0', lookaheadSafe: true },
  { id: 'atr_pct', label: 'ATR %', category: 'volatility', defaultOperator: 'lte', valueHint: '5', lookaheadSafe: true },
  { id: 'regime_bullish', label: 'Bullish Regime', category: 'regime', defaultOperator: 'eq', valueHint: '1', lookaheadSafe: true },
  { id: 'price_above_ema20', label: 'Price Above EMA20', category: 'trend', defaultOperator: 'eq', valueHint: '1', lookaheadSafe: true },
];

export const SUPPORTED_TIMEFRAMES: LabTimeframe[] = ['daily', 'swing'];

export const INDICATOR_IDS = new Set(SUPPORTED_INDICATORS.map((i) => i.id));

export function isSupportedIndicator(id: string): id is SupportedIndicator {
  return INDICATOR_IDS.has(id as SupportedIndicator);
}

export function getIndicatorMeta(id: SupportedIndicator): IndicatorMeta | undefined {
  return SUPPORTED_INDICATORS.find((i) => i.id === id);
}
