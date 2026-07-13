// ════════════════════════════════════════════════════════════════
//  streamServer — WebSocket fan-out for live market ticks
//
//  Clients connect, send { type:'subscribe', symbols:[...] }, and
//  receive push frames (`tick`, `prices`, `FULL_UPDATE`). Ticks
//  originate from tickBus (liveMarketFeed + tickPropagator).
//
//  Mutable state is pinned on globalThis so Turbopack's per-route
//  module graphs share one listener per process (same pattern as
//  tickBus).
// ════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '@/lib/logger';
import { tickBus } from '@/lib/marketData/tickBus';
import {
  MARKET_TICK_EVENT,
  type MarketStreamTick,
  type MarketStreamClientMessage,
} from '@/lib/marketData/marketStreamTypes';
import { setWsSymbolUnion } from '@/lib/marketData/liveMarketFeed';

const log = logger.child({ component: 'streamServer' });

export interface ServerState {
  running: boolean;
  port: number;
}

interface ClientState {
  id: string;
  ws: WebSocket;
  symbols: Set<string>;
  lastPingAt: number;
}

interface StreamServerGlobal {
  clients: Map<string, ClientState>;
  latestBySymbol: Map<string, MarketStreamTick>;
  wss: WebSocketServer | null;
  state: ServerState;
  tickListener: ((tick: MarketStreamTick) => void) | null;
  fullSweepTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  lastConnectedAt: number | null;
  reconnectAttempts: number;
  lastServerError: string | null;
  ticksBroadcast: number;
}

const GLOBAL_KEY = '__q365_stream_server__';

const FULL_SWEEP_MS = Math.max(
  5_000,
  Number(process.env.MARKET_WS_FULL_SWEEP_MS) || 30_000,
);
const HEARTBEAT_MS = 30_000;
const STALE_CLIENT_MS = 90_000;

function createGlobal(): StreamServerGlobal {
  return {
    clients: new Map(),
    latestBySymbol: new Map(),
    wss: null,
    state: { running: false, port: 0 },
    tickListener: null,
    fullSweepTimer: null,
    heartbeatTimer: null,
    lastConnectedAt: null,
    reconnectAttempts: 0,
    lastServerError: null,
    ticksBroadcast: 0,
  };
}

function g(): StreamServerGlobal {
  const root = globalThis as unknown as Record<string, StreamServerGlobal | undefined>;
  if (!root[GLOBAL_KEY]) root[GLOBAL_KEY] = createGlobal();
  return root[GLOBAL_KEY]!;
}

function defaultPort(): number {
  if (process.env.STREAM_WS_PORT) return Number(process.env.STREAM_WS_PORT);
  return process.env.NODE_ENV === 'production' ? 5001 : 3001;
}

function isDisabled(): boolean {
  return (process.env.STREAM_WS_DISABLED ?? '').toLowerCase() === 'true';
}

function toLivePriceArray(ticks: MarketStreamTick[]): MarketStreamTick[] {
  return ticks;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    log.debug('ws send failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function recomputeWsUnion(): void {
  const union = new Set<string>();
  for (const c of g().clients.values()) {
    for (const sym of c.symbols) union.add(sym);
  }
  setWsSymbolUnion([...union]);
}

function handleClientMessage(client: ClientState, raw: string): void {
  let msg: MarketStreamClientMessage;
  try {
    msg = JSON.parse(raw) as MarketStreamClientMessage;
  } catch {
    send(client.ws, { type: 'error', message: 'invalid_json' });
    return;
  }

  if (msg.type === 'ping') {
    client.lastPingAt = Date.now();
    send(client.ws, { type: 'pong', serverNow: Date.now() });
    return;
  }

  if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
    const list = Array.isArray(msg.symbols) ? msg.symbols : [];
    if (msg.type === 'subscribe' && list.length === 0) {
      client.symbols.clear();
      recomputeWsUnion();
      return;
    }
    for (const rawSym of list) {
      const sym = String(rawSym ?? '').trim().toUpperCase();
      if (!sym) continue;
      if (msg.type === 'subscribe') client.symbols.add(sym);
      else client.symbols.delete(sym);
    }
    recomputeWsUnion();

    if (msg.type === 'subscribe') {
      const cached: MarketStreamTick[] = [];
      for (const rawSym of list) {
        const sym = String(rawSym ?? '').trim().toUpperCase();
        const tick = g().latestBySymbol.get(sym);
        if (tick) cached.push(tick);
      }
      if (cached.length > 0) {
        send(client.ws, { type: 'prices', data: toLivePriceArray(cached) });
      }
    }
    return;
  }

  send(client.ws, { type: 'error', message: 'unknown_type' });
}

function broadcastTick(tick: MarketStreamTick): void {
  const store = g();
  const sym = tick.symbol.toUpperCase();
  store.latestBySymbol.set(sym, tick);
  store.ticksBroadcast += 1;

  const deltaFrame = { type: 'prices' as const, data: toLivePriceArray([tick]) };
  const tickFrame  = { type: 'tick' as const, data: tick };

  for (const client of store.clients.values()) {
    if (client.symbols.size > 0 && !client.symbols.has(sym)) continue;
    send(client.ws, deltaFrame);
    send(client.ws, tickFrame);
  }
}

function broadcastFullUpdate(): void {
  const store = g();
  if (store.latestBySymbol.size === 0) return;
  const all = [...store.latestBySymbol.values()];
  const frame = { type: 'FULL_UPDATE' as const, data: toLivePriceArray(all) };
  for (const client of store.clients.values()) {
    send(client.ws, frame);
  }
}

function attachClient(ws: WebSocket): void {
  const store = g();
  const id = randomUUID();
  const client: ClientState = {
    id,
    ws,
    symbols: new Set(),
    lastPingAt: Date.now(),
  };
  store.clients.set(id, client);
  store.lastConnectedAt = Date.now();

  send(ws, { type: 'connected', serverNow: Date.now(), clientId: id });
  log.info('client connected', { clientId: id, clients: store.clients.size });

  ws.on('message', (data) => {
    handleClientMessage(client, data.toString());
  });

  ws.on('close', () => {
    store.clients.delete(id);
    recomputeWsUnion();
    log.info('client disconnected', { clientId: id, clients: store.clients.size });
  });

  ws.on('error', (err) => {
    store.lastServerError = err.message;
    log.warn('client ws error', { clientId: id, error: err.message });
  });
}

function pruneStaleClients(): void {
  const store = g();
  const now = Date.now();
  for (const [id, client] of store.clients) {
    if (now - client.lastPingAt > STALE_CLIENT_MS) {
      try { client.ws.terminate(); } catch { /* ignore */ }
      store.clients.delete(id);
    }
  }
  recomputeWsUnion();
}

export function startStreamServer(): ServerState {
  const store = g();
  if (store.state.running) return store.state;
  if (isDisabled()) {
    log.info('stream server disabled via STREAM_WS_DISABLED');
    return store.state;
  }

  const port = defaultPort();

  try {
    store.wss = new WebSocketServer({ port, host: '0.0.0.0' });
  } catch (err) {
    store.lastServerError = err instanceof Error ? err.message : String(err);
    log.error('failed to bind WebSocket server', { port, error: store.lastServerError });
    return store.state;
  }

  store.wss.on('connection', (ws) => attachClient(ws));
  store.wss.on('error', (err) => {
    store.lastServerError = err.message;
    log.error('wss error', { error: err.message });
  });

  store.tickListener = (tick: MarketStreamTick) => broadcastTick(tick);
  tickBus.on(MARKET_TICK_EVENT, store.tickListener);

  store.fullSweepTimer = setInterval(broadcastFullUpdate, FULL_SWEEP_MS);
  store.heartbeatTimer = setInterval(pruneStaleClients, HEARTBEAT_MS);

  store.state = { running: true, port };
  log.info('stream server listening', { port });
  return store.state;
}

export function stopStreamServer(): void {
  const store = g();
  if (store.tickListener) {
    tickBus.off(MARKET_TICK_EVENT, store.tickListener);
    store.tickListener = null;
  }
  if (store.fullSweepTimer) { clearInterval(store.fullSweepTimer); store.fullSweepTimer = null; }
  if (store.heartbeatTimer) { clearInterval(store.heartbeatTimer); store.heartbeatTimer = null; }

  for (const client of store.clients.values()) {
    try { client.ws.close(); } catch { /* ignore */ }
  }
  store.clients.clear();
  recomputeWsUnion();

  if (store.wss) {
    try { store.wss.close(); } catch { /* ignore */ }
    store.wss = null;
  }
  store.state = { running: false, port: 0 };
}

export function getStreamServerStats() {
  const store = g();
  return {
    running: store.state.running,
    port: store.state.port,
    clientCount: store.clients.size,
    cachedSymbols: store.latestBySymbol.size,
    ticksBroadcast: store.ticksBroadcast,
    lastConnectedAt: store.lastConnectedAt,
    reconnectAttempts: store.reconnectAttempts,
    lastError: store.lastServerError,
  };
}

/** Test helper */
export function _resetStreamServerForTests(): void {
  stopStreamServer();
  delete (globalThis as unknown as Record<string, unknown>)[GLOBAL_KEY];
}

/** Legacy no-op kept for importers that seed Kite instrument maps. */
export async function seedKiteMapFromDaily(_s?: ServerState): Promise<number> {
  return 0;
}
