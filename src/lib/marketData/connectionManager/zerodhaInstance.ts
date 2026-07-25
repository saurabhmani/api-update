/**
 * Per-user Zerodha connection instance.
 *
 * Owns its own access token + KiteTicker wire. Streaming lifecycle is shared
 * with Shoonya via StreamingLifecycle (idempotent connect/disconnect, connect
 * dedupe, generation-guarded reconnect, subscription restore).
 */

import { EventEmitter } from 'events';
import { KiteConnect } from 'kiteconnect';
import { KiteTicker as KiteConnectTicker } from 'kiteconnect';
import { logger } from '@/lib/logger';
import { kiteTickToNormalized } from '@/lib/marketData/brokerProvider/zerodha/convert';
import { NormalizedTickBus } from '@/lib/marketData/brokerProvider/tickBus';
import type { Tick } from '@/lib/marketData/kiteTicker';
import { StreamingLifecycle } from './streamingLifecycle';
import { publishNormalizedLiveTick } from './tickPipeline';
import type {
  BrokerConnectionInstance,
  BrokerConnectionSnapshot,
  BrokerConnectionState,
  ConnectionKey,
} from './types';
import { connectionKeyString } from './types';

const log = logger.child({ component: 'connection.zerodha' });

export class ZerodhaConnectionInstance
  extends EventEmitter
  implements BrokerConnectionInstance
{
  readonly key: ConnectionKey;
  readonly keyString: string;

  private state: BrokerConnectionState = 'idle';
  private refCount = 0;
  private accessToken = '';
  private accountId: string | null = null;
  private lastTickAt: number | null = null;
  private lastSuccessfulPollAt: number | null = null;
  private lastError: string | null = null;
  private wire: InstanceType<typeof KiteConnectTicker> | null = null;
  private http: InstanceType<typeof KiteConnect> | null = null;
  private updatedAt = new Date().toISOString();
  private readonly tokenToSymbol = new Map<number, string>();
  private readonly tickBus = new NormalizedTickBus();
  private readonly life: StreamingLifecycle;

  constructor(key: ConnectionKey) {
    super();
    this.key = key;
    this.keyString = connectionKeyString(key);
    this.life = new StreamingLifecycle(
      `zerodha:${key.userId}`,
      {
        openWire: (generation) => this.openWire(generation),
        closeWire: () => this.teardownWire(),
        restoreSubscriptions: () => this.resubscribe(),
        onLoginRequired: (message) => {
          this.state = 'expired';
          this.lastError = message;
          this.touch();
          this.emit('login_required', message);
        },
        onState: (s) => {
          if (
            s === 'connecting'
            || s === 'connected'
            || s === 'reconnecting'
            || s === 'disconnected'
            || s === 'expired'
            || s === 'error'
          ) {
            this.state = s;
            this.touch();
          }
        },
      },
      { userId: key.userId, provider: 'zerodha' },
    );
  }

  getSnapshot(): BrokerConnectionSnapshot {
    return {
      key: this.key,
      keyString: this.keyString,
      state: this.state,
      sessionVersion: this.life.sessionVersion,
      refCount: this.refCount,
      subscriptionCount: this.life.subscriptionCount(),
      reconnectAttempts: this.life.reconnectAttempts,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt
        ? new Date(this.lastSuccessfulPollAt).toISOString()
        : null,
      lastError: this.lastError,
      hasAuthenticatedSession: Boolean(this.accessToken),
      updatedAt: this.updatedAt,
    };
  }

  addRef(): void {
    this.refCount += 1;
    this.touch();
  }

  async release(): Promise<void> {
    this.refCount = Math.max(0, this.refCount - 1);
    this.touch();
    if (this.refCount === 0) {
      await this.disconnect();
    }
  }

  bumpSessionVersion(): number {
    const v = this.life.bumpSession('manual');
    this.touch();
    return v;
  }

  async authenticate(session: {
    accessToken: string;
    accountId?: string | null;
    authenticatedAt?: string;
  }): Promise<void> {
    const token = session.accessToken.trim();
    if (!token) throw new Error('ZerodhaConnectionInstance.authenticate requires accessToken');
    this.accessToken = token;
    this.accountId = session.accountId?.trim() || this.accountId;
    this.life.bumpSession('oauth_credentials');
    this.lastError = null;

    const apiKey = (process.env.KITE_API_KEY ?? '').trim();
    if (!apiKey) {
      this.state = 'error';
      this.lastError = 'KITE_API_KEY missing';
      this.touch();
      throw new Error(this.lastError);
    }

    this.http = new KiteConnect({ api_key: apiKey, access_token: token });
    this.http.setAccessToken(token);
    this.lastSuccessfulPollAt = Date.now();
    this.touch();
    log.info('zerodha_session_authenticated', {
      userId: this.key.userId,
      sessionVersion: this.life.sessionVersion,
      accountId: this.accountId,
    });
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  /** Idempotent; concurrent calls share one connect promise. */
  async connect(): Promise<void> {
    if (!this.accessToken) {
      this.state = 'error';
      this.lastError = 'not_authenticated';
      this.touch();
      throw new Error('Zerodha connection not authenticated');
    }
    await this.life.connect();
  }

  /** Idempotent; cancels reconnect timers. */
  async disconnect(): Promise<void> {
    await this.life.disconnect();
  }

  async subscribe(brokerRefs: string[]): Promise<void> {
    const added = this.life.addSubscriptions(brokerRefs);
    for (const ref of added) {
      const token = Number(ref);
      if (Number.isFinite(token) && token > 0) {
        this.tokenToSymbol.set(token, ref);
      }
    }
    this.touch();
    if (this.state === 'connected') await this.resubscribe();
  }

  async unsubscribe(brokerRefs: string[]): Promise<void> {
    this.life.removeSubscriptions(brokerRefs);
    this.touch();
    if (this.state === 'connected' && this.wire) {
      const tokens = brokerRefs
        .map((r) => Number(r))
        .filter((n) => Number.isFinite(n) && n > 0);
      for (const t of tokens) this.tokenToSymbol.delete(t);
      if (tokens.length > 0) {
        try {
          this.wire.unsubscribe(tokens);
        } catch { /* ignore */ }
      }
    }
  }

  private async openWire(generation: number): Promise<void> {
    if (!this.life.isGenerationCurrent(generation)) return;

    const apiKey = (process.env.KITE_API_KEY ?? '').trim();
    if (!apiKey) throw new Error('KITE_API_KEY missing');

    // Vendor auto-reconnect OFF — StreamingLifecycle owns backoff.
    const wire = new KiteConnectTicker({
      api_key: apiKey,
      access_token: this.accessToken,
      reconnect: false,
    });
    this.wire = wire;

    wire.on('connect', () => {
      if (this.wire !== wire || !this.life.isGenerationCurrent(generation)) return;
      this.lastError = null;
      this.touch();
      this.life.markAuthenticated(generation);
      this.emit('connected');
      log.info('zerodha_ws_connected', {
        userId: this.key.userId,
        sessionVersion: generation,
      });
    });

    wire.on('ticks', (rawTicks: unknown[]) => {
      if (this.wire !== wire || !this.life.isGenerationCurrent(generation)) return;
      this.lastTickAt = Date.now();
      this.touch();
      this.handleTicks(rawTicks as Array<Record<string, unknown>>);
    });

    wire.on('disconnect', () => {
      if (this.wire !== wire) return;
      this.life.handleWireClosed(generation, 'disconnect');
    });

    wire.on('error', (err: unknown) => {
      if (this.wire !== wire) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.touch();
      this.emit('error', err);
    });

    wire.on('noreconnect', () => {
      if (this.wire !== wire) return;
      this.life.handleWireClosed(generation, 'disconnect');
    });

    wire.connect();
  }

  private handleTicks(rawTicks: Array<Record<string, unknown>>): void {
    for (const t of rawTicks) {
      const token = Number(t.instrument_token);
      if (!Number.isFinite(token) || token <= 0) continue;
      const ohlc = t.ohlc as { open?: number; high?: number; low?: number; close?: number } | undefined;
      const tick: Tick = {
        token,
        symbol: this.tokenToSymbol.get(token),
        lastPrice: Number(t.last_price) || 0,
        volume: typeof t.volume_traded === 'number' ? t.volume_traded : undefined,
        open: ohlc?.open,
        high: ohlc?.high,
        low: ohlc?.low,
        close: ohlc?.close,
        ts: Date.now(),
        source: 'kite',
      };
      const normalized = kiteTickToNormalized({
        tick,
        userId: this.key.userId,
        symbol: tick.symbol,
      });
      // Pipeline: normalize → liveFeedState → broadcast (+ provider bus)
      publishNormalizedLiveTick(normalized, this.tickBus);
      this.emit('tick', normalized);
    }
    this.emit('ticks', rawTicks);
  }

  private async resubscribe(): Promise<void> {
    if (!this.wire || this.state !== 'connected') return;
    const tokens = this.life
      .getSubscriptionRefs()
      .map((r) => Number(r))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (tokens.length === 0) return;
    try {
      this.wire.subscribe(tokens);
      this.wire.setMode(this.wire.modeFull, tokens);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.touch();
    }
  }

  private async teardownWire(): Promise<void> {
    const wire = this.wire;
    this.wire = null;
    if (!wire) return;
    try {
      // KiteTicker is EventEmitter-like; typings omit removeAllListeners.
      (wire as unknown as { removeAllListeners?: () => void }).removeAllListeners?.();
    } catch { /* optional */ }
    try {
      wire.disconnect();
    } catch { /* already down */ }
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }

  /** Test / diagnostics */
  __lifecycle(): StreamingLifecycle {
    return this.life;
  }
}
