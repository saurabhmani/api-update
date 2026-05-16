// ════════════════════════════════════════════════════════════════
//  kiteTicker — NEUTRALIZED STUB // @deprecated marker
//  @deprecated — WebSocket ticker is gone; every state read returns
//  'closed', every tick lookup returns null.
//
//  The Kite integration has been removed from this system (signal- // @deprecated marker
//  only analytics mode). This module previously owned the Kite // @deprecated marker
//  WebSocket singleton; it now exposes the same public surface so
//  ~37 call sites across the repo continue to compile, but every
//  operation reports "not live" and every tick lookup returns null.
//
//  Consumers that previously branched on `ticker.getStatus().state`
//  take the not-live path unconditionally, which matches the new
//  data pipeline (Yahoo-primary). Execution-critical callers that // @deprecated marker
//  used getLiveTick() now throw WsDownError on every call — they
//  should never be invoked in signal-only mode.
//
//  Safe to delete this file outright once every importer has been
//  migrated off these exports. The stub is the transitional step
//  that keeps tsc green during the migration.
// ════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';

export type TickMode = 'ltp' | 'quote' | 'full';

export interface Tick {
  token: number;
  symbol?: string;
  lastPrice: number;
  volume?: number;
  avgPrice?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  change?: number;
  pChange?: number;
  ts: number;
  source?: 'kite' | 'yahoo'; // @deprecated marker
}

export function isFresh(_tick: Tick | null | undefined, _maxAgeMs = 3_000): boolean {
  return false;
}

export class StaleTickError extends Error {
  constructor(public symbol: string, public ageMs: number) {
    super(`STALE_TICK ${symbol} age=${ageMs}ms`);
    this.name = 'StaleTickError';
  }
}
export class NoTickError extends Error {
  constructor(public symbol: string) {
    super(`NO_TICK ${symbol}`);
    this.name = 'NoTickError';
  }
}
export class WsDownError extends Error {
  constructor(public state: string) {
    super(`WS_DOWN state=${state}`);
    this.name = 'WsDownError';
  }
}

export function getLiveTick(_symbol: string): Tick {
  throw new WsDownError('kite_removed'); // @deprecated marker
}

export function tryGetLiveTick(_symbol: string): Tick | null {
  return null;
}

interface KiteTickerStatus { // @deprecated marker
  state:             'idle' | 'connecting' | 'open' | 'closed';
  loginRequired:     boolean;
  subscribedCount:   number;
  subscribed:        number;         // alias consumers use
  ticksCached:       number;
  tickRatePerSec:    number;
  lastTickAt:        number | null;
  lastConnectedAt:   number | null;
  lastError:         string | null;
  reconnectAttempts: number;
  packetsReceived:   number;
  bridgeErrorCount:  number;
}

class KiteTickerStub extends EventEmitter { // @deprecated marker
  readonly ticks = new Map<number, Tick>();

  getStatus(): KiteTickerStatus { // @deprecated marker
    return {
      state:             'closed',
      loginRequired:     true,
      subscribedCount:   0,
      subscribed:        0,
      ticksCached:       0,
      tickRatePerSec:    0,
      lastTickAt:        null,
      lastConnectedAt:   null,
      lastError:         null,
      reconnectAttempts: 0,
      packetsReceived:   0,
      bridgeErrorCount:  0,
    };
  }

  async connect(): Promise<void> { return; }
  async disconnect(): Promise<void> { return; }
  async subscribe(_symbols: string[], _mode: TickMode = 'quote'): Promise<void> { return; }
  async unsubscribe(_symbols: string[]): Promise<void> { return; }

  // Method-name aliases used across the codebase — all no-ops.
  async subscribeSymbols(
    symbols: string[],
    _mode: TickMode = 'quote',
  ): Promise<{ resolved: string[]; unknown: string[] }> {
    // Nothing can resolve without the instrument master; treat every
    // symbol as unknown so callers see they were not subscribed.
    return { resolved: [], unknown: symbols ?? [] };
  }
  async unsubscribeSymbols(
    symbols: string[],
  ): Promise<{ resolved: string[]; unknown: string[] }> {
    return { resolved: [], unknown: symbols ?? [] };
  }
  async listSubscribedSymbols(): Promise<string[]> { return []; }
  getAllTicks(): Tick[] { return []; }
  clearLoginRequired(): void { /* no-op */ }

  getTickBySymbolSync(_symbol: string): Tick | null { return null; }
  async getTickBySymbol(_symbol: string): Promise<Tick | null> { return null; }
  async getSubscribedSymbols(): Promise<string[]> { return []; }
}

const GLOBAL_KEY = '__q365_kite_ticker_stub__'; // @deprecated marker

function getSingleton(): KiteTickerStub { // @deprecated marker
  const g = globalThis as unknown as Record<string, KiteTickerStub | undefined>; // @deprecated marker
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new KiteTickerStub(); // @deprecated marker
  }
  return g[GLOBAL_KEY]!;
}

export function getTicker(): KiteTickerStub { // @deprecated marker
  return getSingleton();
}

export type { KiteTickerStub as KiteTicker }; // @deprecated marker
