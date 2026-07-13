// ════════════════════════════════════════════════════════════════
//  Phase 7 — Experimental Strategy Research (not production)
// ════════════════════════════════════════════════════════════════

import type { ResearchCandle } from '../types';
import type { ResearchFeatureVector } from '../features/researchFeatures';

export type ExperimentalStrategyType =
  | 'trend_following'
  | 'mean_reversion'
  | 'breakout'
  | 'volatility_expansion'
  | 'pairs'
  | 'factor_investing'
  | 'rotation'
  | 'multi_factor';

export interface ExperimentalSignal {
  barIndex: number;
  direction: 'long' | 'short' | 'flat';
  strategyType: ExperimentalStrategyType;
  confidence: number;
  reason: string;
}

export interface ExperimentalStrategyDefinition {
  strategyId: string;
  version: string;
  type: ExperimentalStrategyType;
  description: string;
  parameters: Record<string, number>;
}

const EXPERIMENTAL_STRATEGIES: ExperimentalStrategyDefinition[] = [
  { strategyId: 'exp_trend_follow', version: '1.0.0', type: 'trend_following', description: 'MA slope trend', parameters: { lookback: 20, threshold: 0.02 } },
  { strategyId: 'exp_mean_revert', version: '1.0.0', type: 'mean_reversion', description: 'Z-score reversion', parameters: { lookback: 20, zEntry: 1.5 } },
  { strategyId: 'exp_breakout', version: '1.0.0', type: 'breakout', description: 'Range breakout', parameters: { lookback: 20, buffer: 0.005 } },
  { strategyId: 'exp_vol_expansion', version: '1.0.0', type: 'volatility_expansion', description: 'ATR expansion', parameters: { lookback: 14, mult: 1.5 } },
  { strategyId: 'exp_pairs', version: '1.0.0', type: 'pairs', description: 'Spread z-score', parameters: { zEntry: 2 } },
  { strategyId: 'exp_factor', version: '1.0.0', type: 'factor_investing', description: 'Momentum factor', parameters: { lookback: 60 } },
  { strategyId: 'exp_rotation', version: '1.0.0', type: 'rotation', description: 'Relative strength rotation', parameters: { topN: 3 } },
  { strategyId: 'exp_multi_factor', version: '1.0.0', type: 'multi_factor', description: 'Breadth + trend composite', parameters: { minScore: 0.55 } },
];

export function listExperimentalStrategies(): ExperimentalStrategyDefinition[] {
  return [...EXPERIMENTAL_STRATEGIES];
}

export function getExperimentalStrategy(strategyId: string): ExperimentalStrategyDefinition | null {
  return EXPERIMENTAL_STRATEGIES.find((s) => s.strategyId === strategyId) ?? null;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function evaluateExperimentalStrategy(
  strategy: ExperimentalStrategyDefinition,
  candles: ResearchCandle[],
  features?: ResearchFeatureVector[],
): ExperimentalSignal[] {
  const signals: ExperimentalSignal[] = [];
  const lookback = Math.floor(strategy.parameters.lookback ?? 20);

  for (let i = lookback; i < candles.length; i += 1) {
    const window = candles.slice(i - lookback, i + 1);
    const closes = window.map((c) => c.close);
    const last = closes[closes.length - 1];
    const avg = mean(closes.slice(0, -1));
    const high = Math.max(...closes.slice(0, -1));
    const low = Math.min(...closes.slice(0, -1));
    const feat = features?.find((f) => f.barIndex === i);

    let direction: ExperimentalSignal['direction'] = 'flat';
    let confidence = 0;
    let reason = 'no_signal';

    switch (strategy.type) {
      case 'trend_following': {
        const slope = (last - closes[0]) / closes[0];
        if (slope > (strategy.parameters.threshold ?? 0.02)) {
          direction = 'long'; confidence = 60; reason = 'positive_trend_slope';
        } else if (slope < -(strategy.parameters.threshold ?? 0.02)) {
          direction = 'short'; confidence = 60; reason = 'negative_trend_slope';
        }
        break;
      }
      case 'mean_reversion': {
        const std = Math.sqrt(mean(closes.map((c) => (c - avg) ** 2)));
        const z = std === 0 ? 0 : (last - avg) / std;
        if (z < -(strategy.parameters.zEntry ?? 1.5)) {
          direction = 'long'; confidence = 55; reason = 'oversold_z';
        } else if (z > (strategy.parameters.zEntry ?? 1.5)) {
          direction = 'short'; confidence = 55; reason = 'overbought_z';
        }
        break;
      }
      case 'breakout': {
        const buffer = strategy.parameters.buffer ?? 0.005;
        if (last > high * (1 + buffer)) {
          direction = 'long'; confidence = 65; reason = 'upside_breakout';
        } else if (last < low * (1 - buffer)) {
          direction = 'short'; confidence = 65; reason = 'downside_breakout';
        }
        break;
      }
      case 'volatility_expansion': {
        const ranges = window.slice(1).map((c, idx) => Math.abs(c.close - window[idx].close) / window[idx].close);
        const atr = mean(ranges);
        const recent = ranges[ranges.length - 1];
        if (recent > atr * (strategy.parameters.mult ?? 1.5)) {
          direction = last > avg ? 'long' : 'short';
          confidence = 58; reason = 'vol_expansion';
        }
        break;
      }
      case 'multi_factor': {
        const score = feat
          ? (feat.features.market_breadth + feat.features.trend_persistence) / 2
          : 0;
        if (score >= (strategy.parameters.minScore ?? 0.55)) {
          direction = 'long'; confidence = 62; reason = 'multi_factor_score';
        }
        break;
      }
      default:
        break;
    }

    signals.push({ barIndex: i, direction, strategyType: strategy.type, confidence, reason });
  }
  return signals;
}
