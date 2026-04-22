// ════════════════════════════════════════════════════════════════
//  indicators — incremental EMA / RSI with per-symbol state.
//
//  These functions are designed to be called once per tick on a
//  hot path, so every calculation is O(1) and mutates a small
//  state object instead of re-walking a window buffer.
// ════════════════════════════════════════════════════════════════

export interface EmaState {
  period: number;
  value:  number | null;
}

export function createEma(period: number): EmaState {
  return { period, value: null };
}

export function updateEma(state: EmaState, price: number): number {
  if (state.value == null) {
    state.value = price;
    return price;
  }
  const k = 2 / (state.period + 1);
  state.value = price * k + state.value * (1 - k);
  return state.value;
}

export interface RsiState {
  period:    number;
  prevPrice: number | null;
  avgGain:   number;
  avgLoss:   number;
  samples:   number;
  value:     number | null;
}

export function createRsi(period: number = 14): RsiState {
  return { period, prevPrice: null, avgGain: 0, avgLoss: 0, samples: 0, value: null };
}

/**
 * Wilder's smoothed RSI — standard formulation. Returns null until
 * we have at least `period` samples so callers can skip early
 * ticks where the value would be unreliable.
 */
export function updateRsi(state: RsiState, price: number): number | null {
  if (state.prevPrice == null) {
    state.prevPrice = price;
    return null;
  }
  const change = price - state.prevPrice;
  const gain   = change > 0 ? change  : 0;
  const loss   = change < 0 ? -change : 0;
  state.prevPrice = price;
  state.samples += 1;

  if (state.samples <= state.period) {
    state.avgGain += gain;
    state.avgLoss += loss;
    if (state.samples === state.period) {
      state.avgGain /= state.period;
      state.avgLoss /= state.period;
    } else {
      return null;
    }
  } else {
    state.avgGain = (state.avgGain * (state.period - 1) + gain) / state.period;
    state.avgLoss = (state.avgLoss * (state.period - 1) + loss) / state.period;
  }

  if (state.avgLoss === 0) { state.value = 100; return 100; }
  const rs = state.avgGain / state.avgLoss;
  state.value = 100 - 100 / (1 + rs);
  return state.value;
}

export interface SymbolIndicatorState {
  emaFast: EmaState;
  emaSlow: EmaState;
  rsi:     RsiState;
  lastEmaFast: number | null;
  lastEmaSlow: number | null;
}

export function createSymbolIndicators(
  emaFastPeriod: number = 9,
  emaSlowPeriod: number = 21,
  rsiPeriod:     number = 14,
): SymbolIndicatorState {
  return {
    emaFast:     createEma(emaFastPeriod),
    emaSlow:     createEma(emaSlowPeriod),
    rsi:         createRsi(rsiPeriod),
    lastEmaFast: null,
    lastEmaSlow: null,
  };
}
