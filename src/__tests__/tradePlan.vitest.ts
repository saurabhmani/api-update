import { describe, expect, it, beforeEach } from 'vitest';
import { buildTradePlanForStrategy } from '@/lib/signal-engine/trade-plan/buildTradePlan';
import {
  enhanceTradePlan,
  roundToIndianTick,
  describeTradePlanCalculation,
} from '@/lib/signal-engine/trade-plan/tradePlanEnhancements';
import { resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import type { SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const FEATURES = {
  trend: {
    close: 523.47, ema20: 510, ema50: 495, open: 520,
    closeAbove20Ema: true, closeAbove50Ema: true,
  },
  volatility: { atr14: 12.3, atrPct: 2.35 },
  structure: {
    recentSupport20: 500, recentResistance20: 530,
    recentLow20: 495, recentHigh20: 535,
    breakoutDistancePct: 1.2,
  },
} as unknown as SignalFeatures;

describe('trade plan quality (Phase 2)', () => {
  beforeEach(() => {
    resetSignalEngineConfigCache();
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '2';
    resetSignalEngineConfigCache();
  });

  it('roundToIndianTick uses coarser ticks for higher prices', () => {
    expect(roundToIndianTick(523.47)).toBe(523.45);
    expect(roundToIndianTick(1523.12)).toBe(1523);
  });

  it('enhanceTradePlan rounds prices when enabled', () => {
    const raw = buildTradePlanForStrategy(FEATURES, 'bullish_pullback');
    const enhanced = enhanceTradePlan(raw, FEATURES, 'bullish_pullback', false);
    expect(enhanced.entry.zoneHigh).toBe(roundToIndianTick(raw.entry.zoneHigh));
    expect(enhanced.stopLoss).toBe(roundToIndianTick(enhanced.stopLoss));
  });

  it('describeTradePlanCalculation documents entry/stop/target', () => {
    const plan = buildTradePlanForStrategy(FEATURES, 'bullish_breakout');
    const lines = describeTradePlanCalculation(plan, FEATURES);
    expect(lines.some((l) => l.includes('Entry zone'))).toBe(true);
    expect(lines.some((l) => l.includes('Stop'))).toBe(true);
    expect(lines.some((l) => l.includes('ATR'))).toBe(true);
  });

  it('Phase 1 config skips trade-plan enhancement', () => {
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '1';
    resetSignalEngineConfigCache();
    const raw = buildTradePlanForStrategy(FEATURES, 'bullish_pullback');
    const same = enhanceTradePlan(raw, FEATURES, 'bullish_pullback', false);
    expect(same).toEqual(raw);
  });
});
