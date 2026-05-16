// ════════════════════════════════════════════════════════════════
//  EMA crossover + RSI confirmation strategy.
//
//  Entry
//  ─────
//    BUY  when EMA9 crosses above EMA21 AND RSI14 < 70 (not
//         overbought)
//    SELL when EMA9 crosses below EMA21 AND RSI14 > 30 (not
//         oversold)
//
//  State
//  ─────
//    Per-symbol: EMA fast, EMA slow, RSI14 — stored in a Map.
//    No DB, no Redis read; all state is derived from the tick
//    stream the worker is already consuming.
//
//  Plug in
//  ───────
//    import { createEmaRsiStrategy } from './strategies/emaRsiStrategy';
//    const strategy = createEmaRsiStrategy();
//    new StrategyWorker({ consumerId, strategy }).start();
// ════════════════════════════════════════════════════════════════

import {
  createSymbolIndicators,
  updateEma,
  updateRsi,
  type SymbolIndicatorState,
} from '../indicators';
import type { StrategyFn } from '../strategyWorker';
import type { SignalStreamEntry, TickStreamEntry } from '../streams';

export interface EmaRsiConfig {
  emaFast:       number;
  emaSlow:       number;
  rsiPeriod:     number;
  rsiBuyMax:     number; // don't BUY if RSI above this
  rsiSellMin:    number; // don't SELL if RSI below this
  stopLossPct:   number; // fraction, e.g. 0.01 = 1%
  targetPct:     number; // fraction, e.g. 0.02 = 2%
  minConfidence: number;
  cooldownMs:    number; // skip new signals for this symbol within window
}

export const DEFAULT_EMA_RSI_CONFIG: EmaRsiConfig = {
  emaFast:       9,
  emaSlow:       21,
  rsiPeriod:     14,
  rsiBuyMax:     70,
  rsiSellMin:    30,
  stopLossPct:   0.01,
  targetPct:     0.02,
  minConfidence: 0.55,
  cooldownMs:    5 * 60_000,
};

interface SymbolState extends SymbolIndicatorState {
  lastSignalTs: number;
}

export function createEmaRsiStrategy(cfg: Partial<EmaRsiConfig> = {}): StrategyFn {
  const c: EmaRsiConfig = { ...DEFAULT_EMA_RSI_CONFIG, ...cfg };
  const book = new Map<string, SymbolState>();

  return (tick: TickStreamEntry): SignalStreamEntry | null => {
    if (!tick.ltp) return null;

    let state = book.get(tick.symbol);
    if (!state) {
      state = { ...createSymbolIndicators(c.emaFast, c.emaSlow, c.rsiPeriod), lastSignalTs: 0 };
      book.set(tick.symbol, state);
    }

    const prevFast = state.lastEmaFast;
    const prevSlow = state.lastEmaSlow;
    const fast = updateEma(state.emaFast, tick.ltp);
    const slow = updateEma(state.emaSlow, tick.ltp);
    const rsi  = updateRsi(state.rsi, tick.ltp);
    state.lastEmaFast = fast;
    state.lastEmaSlow = slow;

    // Need at least one prior sample to detect a cross.
    if (prevFast == null || prevSlow == null || rsi == null) return null;

    const now = Date.now();
    if (now - state.lastSignalTs < c.cooldownMs) return null;

    const crossedUp   = prevFast <= prevSlow && fast > slow;
    const crossedDown = prevFast >= prevSlow && fast < slow;

    if (!crossedUp && !crossedDown) return null;

    let direction: 'BUY' | 'SELL' | null = null;
    if (crossedUp   && rsi < c.rsiBuyMax)  direction = 'BUY';
    if (crossedDown && rsi > c.rsiSellMin) direction = 'SELL';
    if (!direction) return null;

    // Confidence: blend of cross magnitude and RSI sweet spot.
    const spread = Math.abs(fast - slow) / tick.ltp;
    const rsiEdge = direction === 'BUY'
      ? 1 - (rsi / c.rsiBuyMax)
      : (rsi - c.rsiSellMin) / (100 - c.rsiSellMin);
    const confidence = Math.max(0, Math.min(1, 0.5 + spread * 50) * 0.5 + rsiEdge * 0.5);
    if (confidence < c.minConfidence) return null;

    state.lastSignalTs = now;

    const entry  = tick.ltp;
    const stop   = direction === 'BUY' ? entry * (1 - c.stopLossPct) : entry * (1 + c.stopLossPct);
    const target = direction === 'BUY' ? entry * (1 + c.targetPct)   : entry * (1 - c.targetPct);

    const signal: SignalStreamEntry = {
      id:         `${tick.symbol}-${tick.ts}-${direction}`,
      symbol:     tick.symbol,
      direction,
      entry,
      stop,
      target,
      confidence,
      strategy:   'ema-rsi',
      ts:         tick.ts,
    };
    return signal;
  };
}
