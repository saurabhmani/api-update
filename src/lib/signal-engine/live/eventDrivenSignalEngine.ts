// ════════════════════════════════════════════════════════════════
//  EventDrivenSignalEngine — pluggable, event-driven signal runner
//
//  The existing `tickStrategyRunner` (sibling file) is the
//  production dispatcher: it wraps the full Phase-4 engine, has
//  throttling, concurrency caps, and fire-and-forget DB reads.
//
//  This module is the OPPOSITE trade-off: a minimal, pure-memory,
//  strategy-agnostic event loop that a caller plugs their own
//  strategy function into. Use cases:
//    - Ad-hoc strategy experiments (bring your own function)
//    - A/B tests against the main engine
//    - Unit tests of strategy logic in isolation
//
//  Rules it enforces for you
//  ─────────────────────────
//  1. Triggered by ticks, not polling — one tickBus listener.
//  2. Never loops over the universe — only the symbol on the
//     incoming tick runs.
//  3. Uses the live lastPrice from the tick (not DB candles).
//  4. Gates emission on tickFreshnessGuard — stale feed → silent.
//  5. Per-symbol throttle (default 1s) to cap CPU on liquid names.
//  6. Zero DB writes in the hot path.
//
//  It does NOT: run the main Phase-4 engine, read candles, or
//  persist signals. For production signal flow, keep using
//  tickStrategyRunner — this is the lightweight sibling.
// ════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { tickBus } from '@/lib/marketData/tickBus';
import {
  installTickFreshnessGuard,
  isMarketDataStale,
} from '@/lib/marketData/tickFreshnessGuard';
import type { TickData, Signal } from '@/lib/marketData/tickTypes';

/**
 * The per-tick strategy function. Receives the fresh tick and a
 * small per-symbol scratchpad the engine maintains between calls.
 * Returns a Signal to emit, or null to stay silent.
 *
 * The scratchpad is a plain object scoped to one symbol — the
 * strategy owns its shape. The engine only guarantees that the
 * same object is handed back on every call for the same symbol.
 */
export type StrategyFn<TState extends object = Record<string, unknown>> = (
  tick: TickData,
  state: TState,
) => Signal | null;

export interface EngineOptions<TState extends object = Record<string, unknown>> {
  /** Human-readable name, used for log lines and telemetry. */
  name: string;
  /** Strategy function. Pure — avoid side effects inside. */
  strategy: StrategyFn<TState>;
  /** Factory for the per-symbol scratchpad. Called on first tick for a symbol. */
  initialState: (symbol: string) => TState;
  /** Only ticks for symbols in this set are evaluated. Omit to allow all. */
  watch?: ReadonlyArray<string>;
  /** Minimum ms between evaluations of the same symbol. Default 1000. */
  throttleMs?: number;
}

export interface EngineStats {
  name:           string;
  ticksSeen:      number;
  ticksEvaluated: number;
  throttled:      number;
  skippedStale:   number;
  skippedUnwatched:number;
  signalsEmitted: number;
  errors:         number;
  startedAt:      number | null;
  lastTickAt:     number | null;
  lastSignalAt:   number | null;
}

export interface RunningEngine extends EventEmitter {
  stop(): void;
  stats(): EngineStats;
}

/**
 * Start the engine. Returns a RunningEngine that extends
 * EventEmitter and fires 'signal' events. Call `stop()` to
 * detach the bus listener.
 *
 *     const engine = startEventDrivenSignalEngine({ ... });
 *     engine.on('signal', (s: Signal) => console.log(s));
 *     // later:
 *     engine.stop();
 */
export function startEventDrivenSignalEngine<TState extends object = Record<string, unknown>>(
  opts: EngineOptions<TState>,
): RunningEngine {
  // Make sure the freshness guard is running. Idempotent.
  installTickFreshnessGuard();

  const throttleMs = opts.throttleMs ?? 1000;
  const watchSet = opts.watch
    ? new Set(opts.watch.map((s) => s.trim().toUpperCase()))
    : null;

  // Per-symbol memory. All O(1) Map ops — no loops over the
  // universe, not even implicit ones via forEach on a global.
  const stateBySymbol = new Map<string, TState>();
  const lastRunBySymbol = new Map<string, number>();

  const stats: EngineStats = {
    name:             opts.name,
    ticksSeen:        0,
    ticksEvaluated:   0,
    throttled:        0,
    skippedStale:     0,
    skippedUnwatched: 0,
    signalsEmitted:   0,
    errors:           0,
    startedAt:        Date.now(),
    lastTickAt:       null,
    lastSignalAt:     null,
  };

  const emitter = new EventEmitter() as RunningEngine;
  emitter.setMaxListeners(32);

  const handler = (tick: TickData): void => {
    stats.ticksSeen += 1;
    stats.lastTickAt = Date.now();

    const sym = tick.symbol;
    if (!sym) return;

    // ── Gate 1: watch filter ─────────────────────────────────
    if (watchSet && !watchSet.has(sym)) {
      stats.skippedUnwatched += 1;
      return;
    }

    // ── Gate 2: per-symbol throttle ──────────────────────────
    const now = Date.now();
    const last = lastRunBySymbol.get(sym) ?? 0;
    if (now - last < throttleMs) {
      stats.throttled += 1;
      return;
    }

    // ── Gate 3: system-wide freshness ────────────────────────
    // If the FEED is stale we must not emit. Note this check is
    // cheap (one Map read + one Date.now subtraction).
    if (isMarketDataStale()) {
      stats.skippedStale += 1;
      return;
    }

    lastRunBySymbol.set(sym, now);
    stats.ticksEvaluated += 1;

    // ── Strategy call ────────────────────────────────────────
    let state = stateBySymbol.get(sym);
    if (!state) {
      state = opts.initialState(sym);
      stateBySymbol.set(sym, state);
    }

    let signal: Signal | null = null;
    try {
      signal = opts.strategy(tick, state);
    } catch (err) {
      stats.errors += 1;
      console.error(
        `[${opts.name}] strategy threw for ${sym}:`,
        (err as Error).message,
      );
      return;
    }

    if (!signal) return;

    stats.signalsEmitted += 1;
    stats.lastSignalAt = Date.now();
    emitter.emit('signal', signal);
    // Also fan out on the global signal event so shared
    // consumers (execution, UI) can pick it up without wiring
    // up to every experimental engine individually.
    tickBus.emit('signal', signal);
  };

  tickBus.on('tick', handler);
  console.log(
    `[${opts.name}] engine started  throttleMs=${throttleMs}  ` +
    `watched=${watchSet ? watchSet.size : 'ALL'}`,
  );

  emitter.stop = (): void => {
    tickBus.off('tick', handler);
    console.log(`[${opts.name}] engine stopped  signals=${stats.signalsEmitted}`);
  };
  emitter.stats = (): EngineStats => ({ ...stats });

  return emitter;
}
