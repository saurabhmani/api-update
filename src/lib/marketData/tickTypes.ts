// ════════════════════════════════════════════════════════════════
//  Shared tick-layer types
//
//  The ticker itself (kiteTicker.ts) owns the wire-level `Tick`
//  interface. This file re-exports it under a domain-friendly
//  alias and adds the two adjacent types that downstream consumers
//  (freshness guard, example consumer, strategy wrappers) need
//  WITHOUT pulling in the entire signal-engine type graph.
//
//  Anything that only wants "a live price + a staleness check +
//  maybe a strategy hint" imports from here — not from the ticker
//  and not from the signal engine.
// ════════════════════════════════════════════════════════════════

import type { Tick } from './kiteTicker';

/**
 * Canonical snapshot of a single instrument at a single instant.
 * Alias of the ticker's `Tick` so external code doesn't need to
 * know the wire format.
 */
export type TickData = Tick;

/** System-wide staleness verdict emitted by tickFreshnessGuard. */
export type MarketState = 'live' | 'stale' | 'disconnected' | 'unauthenticated' | 'closed';

export interface MarketFreshness {
  state:              MarketState;
  lastTickTs:         number | null;   // epoch ms of most recent tick on the bus
  ageMs:              number | null;   // Date.now() - lastTickTs
  maxAgeMs:           number;          // threshold used for the verdict
  subscribedCount:    number;
  ticksReceived:      number;
  reason?:            string;          // populated when state !== 'live'
}

/**
 * Minimal shape a strategy consumer emits when it wants to hand
 * work off to the executor. The full signal engine defines a much
 * richer type (see src/lib/signal-engine/types) — this is the
 * compact variant used by example consumers and the tick-layer
 * smoke tests so they don't pull the whole engine.
 */
export interface Signal {
  symbol:      string;
  side:        'BUY' | 'SELL';
  price:       number;    // trigger price at the moment of emission
  ts:          number;    // epoch ms
  strategy:    string;    // free-form, used for logging / attribution
  confidence?: number;    // 0..1, optional
}
