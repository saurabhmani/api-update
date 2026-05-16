// @deprecated — Kite tick bus residue from the pre-IndianAPI era. The
// resolver does not consult this module. Eligible for deletion at the
// end of the IndianAPI cutover soak window.
// ════════════════════════════════════════════════════════════════
//  tickBus — the single in-process pub/sub channel for market ticks
//
//  Every Kite WebSocket tick, after being parsed by kiteTicker, // @deprecated marker
//  is republished here as a `tick` event. Consumers (strategy
//  engine, UI broadcaster, persistence writer, health probe)
//  listen via `tickBus.on('tick', handler)`.
//
//  ─── Why a dedicated module? ───────────────────────────────────
//  Node's `EventEmitter` is cheap, but creating a fresh instance
//  on every HMR reload means old listeners keep receiving events
//  from a dead emitter while new code listens to a different one.
//  The globalThis pin below guarantees exactly ONE emitter per
//  process, whether the module is loaded once or fifty times.
//
//  Events:
//    'tick' — payload: Tick (from kiteTicker) // @deprecated marker
// ════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import type { Tick } from './kiteTicker'; // @deprecated marker
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tickBus' });

const GLOBAL_KEY = '__q365_tick_bus__';

function getSingleton(): EventEmitter {
  const g = globalThis as unknown as Record<string, EventEmitter | undefined>;
  if (!g[GLOBAL_KEY]) {
    const bus = new EventEmitter();
    // Many concurrent consumers are expected (one per strategy,
    // one per dashboard subscriber, one per persistence writer).
    // Raise the default 10-listener soft cap to avoid the noisy
    // "possible memory leak" warning for legitimate use.
    bus.setMaxListeners(256);
    g[GLOBAL_KEY] = bus;
    console.log('[tickBus] created (single-process)');
  }
  return g[GLOBAL_KEY]!;
}

export const tickBus: EventEmitter = getSingleton();

// Typed helpers — so call sites don't need to stringify the event
// name every time and get autocompletion for the payload shape.
export function onTick(handler: (tick: Tick) => void): () => void {
  tickBus.on('tick', handler);
  return () => tickBus.off('tick', handler);
}
