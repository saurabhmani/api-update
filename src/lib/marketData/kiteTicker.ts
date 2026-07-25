// ════════════════════════════════════════════════════════════════
//  kiteTicker — Kite Connect WebSocket integration
// ════════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { KiteTicker as KiteConnectTicker } from 'kiteconnect';
import { getKiteClient } from '../kite/client';
import { getInstrumentBySymbol, downloadInstruments } from '../kite/instruments';
import { logger } from '@/lib/logger';
import { recordKiteCall } from '../kite/health';

const log = logger.child({ component: 'kite.ticker' });

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
  source?: 'kite' | 'yahoo' | 'zerodha' | 'shoonya' | string;
}

export function isFresh(tick: Tick | null | undefined, maxAgeMs = 3_000): boolean {
  if (!tick) return false;
  return Date.now() - tick.ts <= maxAgeMs;
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

interface KiteTickerStatus {
  state:             'idle' | 'connecting' | 'open' | 'closed';
  loginRequired:     boolean;
  subscribedCount:   number;
  subscribed:        number;
  ticksCached:       number;
  tickRatePerSec:    number;
  lastTickAt:        number | null;
  lastConnectedAt:   number | null;
  lastError:         string | null;
  reconnectAttempts: number;
  packetsReceived:   number;
  bridgeErrorCount:  number;
}

class KiteTickerImpl extends EventEmitter {
  readonly ticks = new Map<number, Tick>();
  private tokenToSymbol = new Map<number, string>();
  private symbolToToken = new Map<string, number>();

  private ticker: any | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  private loginRequired = false;
  private lastTickAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private packetsReceived = 0;
  private bridgeErrorCount = 0;

  private activeSubscriptions = new Set<string>();

  getStatus(): KiteTickerStatus {
    return {
      state:             this.state,
      loginRequired:     this.loginRequired,
      subscribedCount:   this.activeSubscriptions.size,
      subscribed:        this.activeSubscriptions.size,
      ticksCached:       this.ticks.size,
      tickRatePerSec:    0,
      lastTickAt:        this.lastTickAt,
      lastConnectedAt:   this.lastConnectedAt,
      lastError:         this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      packetsReceived:   this.packetsReceived,
      bridgeErrorCount:  this.bridgeErrorCount,
    };
  }

  async connect(): Promise<void> {
    if (this.state === 'open' || this.state === 'connecting') return;
    this.state = 'connecting';
    const client = getKiteClient();

    // Boot may run before OAuth; hydrate Redis / broker_connections so a
    // late connect (post-login) does not bail with loginRequired.
    if (!client.getConfig().accessToken) {
      try {
        await client.hydrateAccessTokenFromSession();
      } catch {
        /* hydrate is best-effort */
      }
    }

    const config = client.getConfig();

    if (!config.apiKey || !config.accessToken) {
      this.state = 'closed';
      this.loginRequired = true;
      log.warn('Cannot connect KiteTicker: Missing apiKey or accessToken');
      return;
    }

    this.loginRequired = false;

    // Tear down any prior wire client before replacing — otherwise its
    // reconnect timers can still mutate this.state after a token refresh.
    await this.teardownWireTicker();

    const wire = new KiteConnectTicker({
      api_key: config.apiKey,
      access_token: config.accessToken,
    });
    this.ticker = wire;

    wire.on('connect', () => {
      if (this.ticker !== wire) return;
      this.state = 'open';
      this.lastConnectedAt = Date.now();
      this.loginRequired = false;
      log.info('Kite WebSocket connected');
      if (this.activeSubscriptions.size > 0) {
        this.resubscribeActive().catch(err => log.error('Failed to resubscribe', { error: err }));
      }
    });

    wire.on('ticks', (wireTicks: any[]) => {
      if (this.ticker !== wire) return;
      this.packetsReceived += 1;
      this.lastTickAt = Date.now();
      
      const parsedTicks: Tick[] = [];
      for (const t of wireTicks) {
        if (!t.instrument_token) continue;
        const sym = this.tokenToSymbol.get(t.instrument_token);
        
        let pChange = t.change;
        let change = t.ohlc?.close ? t.last_price - t.ohlc.close : 0;
        
        if (typeof t.change === 'number' && t.ohlc?.close && change !== 0) {
           pChange = t.change;
           change = (pChange / 100) * t.ohlc.close;
        }

        const tick: Tick = {
          token: t.instrument_token,
          symbol: sym,
          lastPrice: t.last_price,
          volume: t.volume_traded,
          avgPrice: t.average_traded_price,
          open: t.ohlc?.open,
          high: t.ohlc?.high,
          low: t.ohlc?.low,
          close: t.ohlc?.close,
          change: change,
          pChange: pChange,
          ts: Date.now(),
          source: 'kite',
        };
        this.ticks.set(t.instrument_token, tick);
        parsedTicks.push(tick);
      }
      this.emit('ticks', parsedTicks);
    });

    wire.on('disconnect', () => {
      if (this.ticker !== wire) return;
      this.state = 'closed';
      log.warn('Kite WebSocket disconnected');
    });

    wire.on('error', (err: any) => {
      if (this.ticker !== wire) return;
      this.lastError = err?.message || String(err);
      this.bridgeErrorCount += 1;
      log.error('Kite WebSocket error', { error: err });
    });

    // kiteconnect emits 'reconnect' (not 'reconnecting'); signature is
    // (reconnect_count, reconnect_interval).
    wire.on('reconnect', (attempt: number, _interval: number) => {
      if (this.ticker !== wire) return;
      this.reconnectAttempts = attempt;
      this.state = 'connecting';
      log.warn(`Kite WebSocket reconnecting (attempt ${attempt})`);
    });

    wire.on('noreconnect', () => {
      if (this.ticker !== wire) return;
      this.state = 'closed';
      log.error('Kite WebSocket max reconnects reached');
    });

    wire.connect();
  }

  /** Stop and drop the underlying kiteconnect client so it cannot reconnect. */
  private async teardownWireTicker(): Promise<void> {
    const wire = this.ticker;
    this.ticker = null;
    if (!wire) return;
    try {
      wire.removeAllListeners?.();
    } catch { /* optional API */ }
    try {
      wire.disconnect();
    } catch { /* already down */ }
  }

  async disconnect(): Promise<void> {
    await this.teardownWireTicker();
    this.state = 'closed';
  }

  private async resolveSymbols(symbols: string[]): Promise<{ tokens: number[], unknown: string[] }> {
    const tokens: number[] = [];
    const unknown: string[] = [];

    await downloadInstruments();

    for (const sym of symbols) {
      if (this.symbolToToken.has(sym)) {
        tokens.push(this.symbolToToken.get(sym)!);
        continue;
      }
      const inst = await getInstrumentBySymbol(sym);
      if (inst && inst.instrument_token) {
        const token = Number(inst.instrument_token);
        this.symbolToToken.set(sym, token);
        this.tokenToSymbol.set(token, sym);
        tokens.push(token);
      } else {
        unknown.push(sym);
      }
    }
    return { tokens, unknown };
  }

  private async resubscribeActive() {
    if (!this.ticker || this.state !== 'open') return;
    const { tokens } = await this.resolveSymbols(Array.from(this.activeSubscriptions));
    if (tokens.length > 0) {
      this.ticker.subscribe(tokens);
      this.ticker.setMode(this.ticker.modeFull, tokens);
    }
  }

  async subscribe(symbols: string[], mode: TickMode = 'quote'): Promise<void> {
    await this.subscribeSymbols(symbols, mode);
  }

  async unsubscribe(symbols: string[]): Promise<void> {
    await this.unsubscribeSymbols(symbols);
  }

  async subscribeSymbols(
    symbols: string[],
    mode: TickMode = 'quote',
  ): Promise<{ resolved: string[]; unknown: string[] }> {
    for (const sym of symbols) {
      this.activeSubscriptions.add(sym);
    }

    const { tokens, unknown } = await this.resolveSymbols(symbols);
    const resolved = symbols.filter(s => !unknown.includes(s));

    if (this.ticker && this.state === 'open' && tokens.length > 0) {
      this.ticker.subscribe(tokens);
      let kiteMode = this.ticker.modeQuote;
      if (mode === 'ltp') kiteMode = this.ticker.modeLTP;
      else if (mode === 'full') kiteMode = this.ticker.modeFull;
      
      this.ticker.setMode(kiteMode, tokens);
    }

    return { resolved, unknown };
  }

  async unsubscribeSymbols(
    symbols: string[],
  ): Promise<{ resolved: string[]; unknown: string[] }> {
    for (const sym of symbols) {
      this.activeSubscriptions.delete(sym);
    }

    const { tokens, unknown } = await this.resolveSymbols(symbols);
    const resolved = symbols.filter(s => !unknown.includes(s));

    if (this.ticker && this.state === 'open' && tokens.length > 0) {
      this.ticker.unsubscribe(tokens);
    }

    return { resolved, unknown };
  }

  async listSubscribedSymbols(): Promise<string[]> {
    return Array.from(this.activeSubscriptions);
  }

  getAllTicks(): Tick[] {
    return Array.from(this.ticks.values());
  }

  clearLoginRequired(): void {
    this.loginRequired = false;
  }

  getTickBySymbolSync(symbol: string): Tick | null {
    const token = this.symbolToToken.get(symbol);
    if (!token) return null;
    return this.ticks.get(token) || null;
  }

  async getTickBySymbol(symbol: string): Promise<Tick | null> {
    return this.getTickBySymbolSync(symbol);
  }

  async getSubscribedSymbols(): Promise<string[]> {
    return this.listSubscribedSymbols();
  }
}

const GLOBAL_KEY = '__q365_kite_ticker_impl__';

function getSingleton(): KiteTickerImpl {
  const g = globalThis as unknown as Record<string, KiteTickerImpl | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new KiteTickerImpl();
  }
  return g[GLOBAL_KEY]!;
}

export function getTicker(): KiteTickerImpl {
  return getSingleton();
}

export function getLiveTick(symbol: string): Tick {
  const t = getTicker().getTickBySymbolSync(symbol);
  if (!t) throw new NoTickError(symbol);
  return t;
}

export function tryGetLiveTick(symbol: string): Tick | null {
  return getTicker().getTickBySymbolSync(symbol);
}

export type { KiteTickerImpl as KiteTicker };
