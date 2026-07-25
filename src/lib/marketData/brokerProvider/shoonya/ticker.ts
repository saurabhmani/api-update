/**
 * Shoonya WebSocket ticker — touchline subscribe, reconnect, session expiry.
 *
 * Uses StreamingLifecycle for the same guarantees as Zerodha:
 *   idempotent connect/disconnect, connect dedupe, generation-guarded reconnect,
 *   subscription restore, permanent-auth stop, bounded backoff.
 *
 * Emits NormalizedTick via tick pipeline (liveFeedState + process bus).
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { logger } from '@/lib/logger';
import {
  StreamingLifecycle,
  classifyStreamError,
} from '@/lib/marketData/connectionManager/streamingLifecycle';
import { publishNormalizedLiveTick } from '@/lib/marketData/connectionManager/tickPipeline';
import {
  isSessionExpiryMessage,
  markProviderSessionExpired,
} from '../connectionHelpers';
import { toShoonyaScripKey } from '../instrumentKey';
import type { NormalizedTickBus } from '../tickBus';
import {
  shoonyaTouchlineToNormalized,
  type ShoonyaQuoteRaw,
} from './convert';
import type { ShoonyaSessionCreds } from './restClient';

const log = logger.child({ component: 'shoonya.ticker' });

const DEFAULT_WS_URL = 'wss://api.shoonya.com/NorenWSAPI/';
const PING_MS = 3_000;

export type ShoonyaTickerState = 'idle' | 'connecting' | 'open' | 'closed' | 'expired';

export interface ShoonyaTickerStatus {
  state: ShoonyaTickerState;
  subscribedCount: number;
  lastTickAt: number | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  reconnectAttempts: number;
  sessionVersion: number;
}

interface SubMeta {
  symbol: string;
  exchange: string;
  token: string;
}

export class ShoonyaTicker extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: ShoonyaTickerState = 'idle';
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private openGeneration = 0;

  /** scripKey → meta */
  private readonly subscriptions = new Map<string, SubMeta>();
  /** token → scripKey (tk field is token only) */
  private readonly tokenIndex = new Map<string, string>();

  private readonly life: StreamingLifecycle;

  constructor(
    private session: ShoonyaSessionCreds,
    private readonly tickBus: NormalizedTickBus,
    private readonly wsUrl = process.env.SHOONYA_WS_URL?.trim() || DEFAULT_WS_URL,
  ) {
    super();
    this.life = new StreamingLifecycle(
      `shoonya:${session.userId}`,
      {
        openWire: (generation) => this.openSocket(generation),
        closeWire: () => this.teardownSocket(),
        restoreSubscriptions: () => {
          this.resubscribeAll();
        },
        onLoginRequired: (message) => {
          this.state = 'expired';
          this.lastError = message;
          void markProviderSessionExpired('shoonya', this.session.userId);
          this.emit('session_expired', message);
        },
        onState: (s) => {
          if (s === 'connecting' || s === 'reconnecting') this.state = 'connecting';
          else if (s === 'connected') this.state = 'open';
          else if (s === 'disconnected') this.state = 'closed';
          else if (s === 'expired') this.state = 'expired';
          else if (s === 'error') this.state = 'closed';
        },
      },
      { userId: String(session.userId), provider: 'shoonya' },
    );
  }

  getStatus(): ShoonyaTickerStatus {
    return {
      state: this.state,
      subscribedCount: this.subscriptions.size,
      lastTickAt: this.lastTickAt,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      reconnectAttempts: this.life.reconnectAttempts,
      sessionVersion: this.life.sessionVersion,
    };
  }

  /**
   * Apply credentials for this user only.
   * Session bump (invalidates stale sockets / reconnect) only when token changes.
   */
  updateSession(session: ShoonyaSessionCreds): void {
    const changed =
      this.session.accessToken !== session.accessToken
      || this.session.uid !== session.uid
      || this.session.actid !== session.actid;
    this.session = session;
    if (changed) {
      this.life.bumpSession('oauth_credentials');
    }
  }

  /** Idempotent; concurrent calls share one connect promise. */
  async connect(): Promise<void> {
    await this.life.connect();
  }

  /** Idempotent; cancels reconnect timers. */
  async disconnect(): Promise<void> {
    await this.life.disconnect();
  }

  subscribeScrips(
    items: Array<{ exchange: string; token: string; symbol: string }>,
  ): void {
    const keys: string[] = [];
    for (const item of items) {
      const key = toShoonyaScripKey(item.exchange, item.token);
      this.subscriptions.set(key, {
        symbol: item.symbol.toUpperCase(),
        exchange: item.exchange.toUpperCase(),
        token: String(item.token),
      });
      this.tokenIndex.set(String(item.token), key);
      this.life.addSubscriptions([key]);
      keys.push(key);
    }
    if (this.state === 'open' && keys.length > 0) {
      this.send({ t: 't', k: keys.join('#') });
    }
  }

  unsubscribeScrips(
    items: Array<{ exchange: string; token: string }>,
  ): void {
    const keys: string[] = [];
    for (const item of items) {
      const key = toShoonyaScripKey(item.exchange, item.token);
      this.subscriptions.delete(key);
      this.tokenIndex.delete(String(item.token));
      this.life.removeSubscriptions([key]);
      keys.push(key);
    }
    if (this.state === 'open' && keys.length > 0) {
      this.send({ t: 'u', k: keys.join('#') });
    }
  }

  private openSocket(generation: number): void {
    if (!this.life.isGenerationCurrent(generation)) return;
    this.openGeneration = generation;
    this.state = 'connecting';

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = 'closed';
      this.life.handleWireClosed(generation, this.lastError);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws || !this.life.isGenerationCurrent(generation)) return;
      this.send({
        t: 'a',
        uid: this.session.uid,
        actid: this.session.actid,
        source: 'API',
        accesstoken: this.session.accessToken,
      });
    });

    ws.on('message', (data) => {
      if (this.ws !== ws || !this.life.isGenerationCurrent(generation)) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.handleMessage(msg, generation);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.state === 'expired') return;
      this.state = 'closed';
      log.warn('Shoonya WebSocket closed', { userId: this.session.userId, generation });
      this.life.handleWireClosed(generation, this.lastError || 'disconnect');
    });

    ws.on('error', (err) => {
      if (this.ws !== ws) return;
      this.lastError = err?.message || String(err);
      log.error('Shoonya WebSocket error', { error: this.lastError });
      this.emit('error', err);
    });
  }

  private handleMessage(msg: Record<string, unknown>, generation: number): void {
    const t = String(msg.t ?? '');

    if (t === 'ak' || t === 'ck') {
      const ok = String(msg.s ?? '').toUpperCase() === 'OK';
      if (ok) {
        this.state = 'open';
        this.lastConnectedAt = Date.now();
        this.lastError = null;
        this.startPing();
        this.life.markAuthenticated(generation);
        this.emit('connected');
        log.info('Shoonya WebSocket authenticated', {
          userId: this.session.userId,
          sessionVersion: generation,
        });
        return;
      }
      const emsg = typeof msg.emsg === 'string' ? msg.emsg : 'auth failed';
      this.lastError = emsg;
      if (
        isSessionExpiryMessage(emsg)
        || classifyStreamError(emsg) === 'permanent_auth'
        || /fail|invalid|denied/i.test(emsg)
      ) {
        this.life.markPermanentAuthFailure(emsg);
      } else {
        this.life.handleWireClosed(generation, emsg);
      }
      this.emit('error', new Error(`Shoonya WS auth failed: ${emsg.slice(0, 120)}`));
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (t === 'tk' || t === 'tf') {
      this.lastTickAt = Date.now();
      const raw = msg as ShoonyaQuoteRaw;
      if (raw.lp == null) return;
      const token = String(raw.tk ?? raw.token ?? '');
      const scripKey = this.tokenIndex.get(token)
        || (raw.e ? toShoonyaScripKey(String(raw.e), token) : '');
      const meta = scripKey ? this.subscriptions.get(scripKey) : undefined;
      if (!meta) return;

      const tick = shoonyaTouchlineToNormalized({
        raw,
        userId: String(this.session.userId),
        symbol: meta.symbol,
        exchange: meta.exchange,
        brokerToken: meta.token,
      });
      // Pipeline: normalize → liveFeedState → broadcast (+ provider bus)
      publishNormalizedLiveTick(tick, this.tickBus);
      this.emit('tick', tick);
      return;
    }
  }

  private resubscribeAll(): void {
    if (this.subscriptions.size === 0) return;
    const keys = [...this.subscriptions.keys()];
    const CHUNK = 50;
    for (let i = 0; i < keys.length; i += CHUNK) {
      this.send({ t: 't', k: keys.slice(i, i + CHUNK).join('#') });
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('{"t":"h"}');
      }
    }, PING_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private async teardownSocket(): Promise<void> {
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (this.state !== 'expired') this.state = 'closed';
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {
      /* already down */
    }
  }

  /** Test / diagnostics */
  __lifecycle(): StreamingLifecycle {
    return this.life;
  }

  __openGeneration(): number {
    return this.openGeneration;
  }
}

/** Process-global map: one Shoonya WS per Quantorus user (broker limit: 1 WS/account). */
const GLOBAL_KEY = '__q365_shoonya_tickers__';

function tickerMap(): Map<number, ShoonyaTicker> {
  const g = globalThis as unknown as Record<string, Map<number, ShoonyaTicker> | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

export function getShoonyaTickerForUser(
  userId: number,
  session: ShoonyaSessionCreds,
  tickBus: NormalizedTickBus,
): ShoonyaTicker {
  const map = tickerMap();
  let ticker = map.get(userId);
  if (!ticker) {
    ticker = new ShoonyaTicker(session, tickBus);
    map.set(userId, ticker);
  } else {
    ticker.updateSession(session);
  }
  return ticker;
}

export async function disconnectShoonyaTicker(userId: number): Promise<void> {
  const map = tickerMap();
  const ticker = map.get(userId);
  if (!ticker) return;
  await ticker.disconnect();
  map.delete(userId);
}
