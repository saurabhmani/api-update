// ════════════════════════════════════════════════════════════════
//  bootTicker — NEUTRALIZED STUB
//
//  Previously booted the Kite WebSocket singleton, loaded the NSE
//  universe, subscribed symbols, and registered the signal executor.
//  In signal-only mode the WebSocket is not started, no symbols are
//  subscribed, and no broker-side executor is registered.
//
//  bootTicker() is still exported and still returns a BootResult so
//  instrumentation.ts and any callers (e.g. /api/kite/ticker — also
//  being removed) continue to compile. It resolves immediately with
//  `booted: false`.
// ════════════════════════════════════════════════════════════════

import type { TickMode } from './kiteTicker';

export interface BootResult {
  booted:         boolean;
  alreadyBooted:  boolean;
  universeSize:   number;
  mode:           TickMode;
}

export async function bootTicker(): Promise<BootResult> {
  return {
    booted:        false,
    alreadyBooted: false,
    universeSize:  0,
    mode:          'quote',
  };
}

export async function bootTickerSafe(): Promise<BootResult | { booted: false; error: string }> {
  return { booted: false, error: 'kite_removed' };
}
