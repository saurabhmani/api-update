// Singleton browser WebSocket client shared across all React hooks.
// One connection per tab; symbol subscriptions are ref-counted.

'use client';

import {
  type MarketStreamTick,
  type MarketStreamStatus,
} from '@/lib/marketData/marketStreamTypes';
import { isMarketWsDisabled, resolveMarketWsUrl } from '@/lib/marketData/wsUrl';

type Listener = () => void;

export interface MarketStreamSnapshot {
  status:      MarketStreamStatus;
  ticks:       Map<string, MarketStreamTick>;
  lastAt:      number | null;
  serverNow:   number | null;
  reconnectAttempt: number;
}

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

/** Stable SSR / hydration snapshot — never mutate. */
export const MARKET_STREAM_SERVER_SNAPSHOT: MarketStreamSnapshot = {
  status: 'disconnected',
  ticks: new Map(),
  lastAt: null,
  serverNow: null,
  reconnectAttempt: 0,
};

function emptyClientSnapshot(): MarketStreamSnapshot {
  return {
    status: 'disconnected',
    ticks: new Map(),
    lastAt: null,
    serverNow: null,
    reconnectAttempt: 0,
  };
}

class MarketStreamClient {
  private ws: WebSocket | null = null;
  private status: MarketStreamStatus = 'disconnected';
  private ticks = new Map<string, MarketStreamTick>();
  private lastAt: number | null = null;
  private serverNow: number | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private listeners = new Set<Listener>();
  private symbolRefs = new Map<string, number>();
  private receiveAllRefs = 0;
  private pendingFlush: ReturnType<typeof requestAnimationFrame> | null = null;
  private dirty = false;
  /** Cached store snapshot — same reference between notifications. */
  private snapshot: MarketStreamSnapshot = emptyClientSnapshot();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Never connect (and notify) synchronously — useSyncExternalStore /
    // useEffect subscribers must not trigger updates during subscribe.
    queueMicrotask(() => this.ensureConnected());
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  enableReceiveAll(): void {
    this.receiveAllRefs += 1;
    this.ensureConnected();
    // Empty subscription on the server = receive all ticks.
    this.sendSubscribe([]);
  }

  disableReceiveAll(): void {
    this.receiveAllRefs = Math.max(0, this.receiveAllRefs - 1);
    if (this.receiveAllRefs === 0) {
      this.sendSubscribe([...this.symbolRefs.keys()]);
    }
  }

  addSymbols(symbols: string[]): void {
    let changed = false;
    for (const raw of symbols) {
      const sym = String(raw ?? '').trim().toUpperCase();
      if (!sym) continue;
      const next = (this.symbolRefs.get(sym) ?? 0) + 1;
      this.symbolRefs.set(sym, next);
      changed = true;
    }
    if (changed) {
      this.ensureConnected();
      this.sendSubscribe([...this.symbolRefs.keys()]);
    }
  }

  removeSymbols(symbols: string[]): void {
    let changed = false;
    for (const raw of symbols) {
      const sym = String(raw ?? '').trim().toUpperCase();
      if (!sym) continue;
      const cur = this.symbolRefs.get(sym) ?? 0;
      if (cur <= 1) {
        this.symbolRefs.delete(sym);
        this.ticks.delete(sym);
      } else {
        this.symbolRefs.set(sym, cur - 1);
      }
      changed = true;
    }
    if (changed && this.ws?.readyState === WebSocket.OPEN) {
      this.sendMessage({ type: 'unsubscribe', symbols });
      this.sendSubscribe([...this.symbolRefs.keys()]);
    }
    if (changed) this.notify();
  }

  getSnapshot(): MarketStreamSnapshot {
    return this.snapshot;
  }

  private notify(): void {
    const prev = this.snapshot;
    const next: MarketStreamSnapshot = {
      status: this.status,
      ticks: this.ticks,
      lastAt: this.lastAt,
      serverNow: this.serverNow,
      reconnectAttempt: this.reconnectAttempt,
    };
    if (
      prev.status === next.status &&
      prev.ticks === next.ticks &&
      prev.lastAt === next.lastAt &&
      prev.serverNow === next.serverNow &&
      prev.reconnectAttempt === next.reconnectAttempt
    ) {
      return;
    }
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private scheduleFlush(): void {
    if (this.pendingFlush != null) return;
    this.pendingFlush = requestAnimationFrame(() => {
      this.pendingFlush = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.notify();
    });
  }

  private ensureConnected(): void {
    if (isMarketWsDisabled()) {
      this.status = 'disconnected';
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;
    this.connect();
  }

  private connect(): void {
    if (isMarketWsDisabled()) return;
    if (this.reconnectAttempt > 0) this.status = 'reconnecting';
    else this.status = 'connecting';
    this.notify();

    const url = resolveMarketWsUrl();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.status = 'connected';
      this.startPing();
      if (this.receiveAllRefs > 0) this.sendSubscribe([]);
      else this.sendSubscribe([...this.symbolRefs.keys()]);
      this.notify();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'connected') {
          this.serverNow = typeof msg.serverNow === 'number' ? msg.serverNow : Date.now();
          return;
        }
        if (msg?.type === 'pong') {
          this.serverNow = typeof msg.serverNow === 'number' ? msg.serverNow : Date.now();
          return;
        }
        if (msg?.type === 'tick' && msg.data?.symbol) {
          this.ingestTicks([msg.data as MarketStreamTick]);
          return;
        }
        if ((msg?.type === 'prices' || msg?.type === 'FULL_UPDATE') && Array.isArray(msg.data)) {
          this.ingestTicks(msg.data as MarketStreamTick[], msg.type === 'FULL_UPDATE');
        }
      } catch { /* malformed frame */ }
    };

    ws.onerror = () => { /* onclose handles reconnect */ };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      this.status = 'disconnected';
      this.notify();
      if (!this.closedByUser) this.scheduleReconnect();
    };
  }

  private ingestTicks(frames: MarketStreamTick[], replace = false): void {
    if (frames.length === 0) return;
    if (replace) this.ticks.clear();
    const now = Date.now();
    for (const f of frames) {
      if (!f?.symbol || !Number.isFinite(f.price)) continue;
      const sym = f.symbol.toUpperCase();
      this.ticks.set(sym, { ...f, symbol: sym });
    }
    this.lastAt = now;
    this.dirty = true;
    this.scheduleFlush();
  }

  private sendSubscribe(symbols: string[]): void {
    // Empty array = receive-all mode on the server.
    this.sendMessage({ type: 'subscribe', symbols });
  }

  private sendMessage(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendMessage({ type: 'ping' });
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || isMarketWsDisabled()) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempt += 1;
    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(5, this.reconnectAttempt - 1));
    const jitter = Math.floor(Math.random() * 500);
    this.status = 'reconnecting';
    this.notify();
    this.reconnectTimer = setTimeout(() => this.connect(), exp + jitter);
  }

  private disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.status = 'disconnected';
    this.notify();
  }
}

let singleton: MarketStreamClient | null = null;

export function getMarketStreamClient(): MarketStreamClient {
  if (!singleton) singleton = new MarketStreamClient();
  return singleton;
}

/** Test helper — reset singleton between unit tests. */
export function _resetMarketStreamClientForTests(): void {
  singleton = null;
}
