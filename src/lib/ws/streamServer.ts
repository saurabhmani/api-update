// ════════════════════════════════════════════════════════════════
//  streamServer — WebSocket fan-out for live market ticks
//
//  Clients connect, send { type:'subscribe', symbols:[...] }, and
//  receive push frames (`tick`, `prices`, `FULL_UPDATE`). Ticks
//  originate from tickBus (liveMarketFeed + tickPropagator).
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

const clients = new Map<string, ClientState>();
const latestBySymbol = new Map<string, MarketStreamTick>();

let wss: WebSocketServer | null = null;
let state: ServerState = { running: false, port: 0 };
let tickListener: ((tick: MarketStreamTick) => void) | null = null;
let fullSweepTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

let lastConnectedAt: number | null = null;
let reconnectAttempts = 0;
let lastServerError: string | null = null;
let ticksBroadcast = 0;

const FULL_SWEEP_MS = Math.max(
  5_000,
  Number(process.env.MARKET_WS_FULL_SWEEP_MS) || 30_000,
);
const HEARTBEAT_MS = 30_000;
const STALE_CLIENT_MS = 90_000;

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
  for (const c of clients.values()) {
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

    // Push cached ticks for newly subscribed symbols immediately.
    if (msg.type === 'subscribe') {
      const cached: MarketStreamTick[] = [];
      for (const rawSym of list) {
        const sym = String(rawSym ?? '').trim().toUpperCase();
        const tick = latestBySymbol.get(sym);
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
  const sym = tick.symbol.toUpperCase();
  latestBySymbol.set(sym, tick);
  ticksBroadcast += 1;

  const deltaFrame = { type: 'prices' as const, data: toLivePriceArray([tick]) };
  const tickFrame  = { type: 'tick' as const, data: tick };

  for (const client of clients.values()) {
    if (client.symbols.size > 0 && !client.symbols.has(sym)) continue;
    // Empty subscription set = receive all (dashboard mode).
    send(client.ws, deltaFrame);
    send(client.ws, tickFrame);
  }
}

function broadcastFullUpdate(): void {
  if (latestBySymbol.size === 0) return;
  const all = [...latestBySymbol.values()];
  const frame = { type: 'FULL_UPDATE' as const, data: toLivePriceArray(all) };
  for (const client of clients.values()) {
    send(client.ws, frame);
  }
}

function attachClient(ws: WebSocket): void {
  const id = randomUUID();
  const client: ClientState = {
    id,
    ws,
    symbols: new Set(),
    lastPingAt: Date.now(),
  };
  clients.set(id, client);
  lastConnectedAt = Date.now();

  send(ws, { type: 'connected', serverNow: Date.now(), clientId: id });
  log.info('client connected', { clientId: id, clients: clients.size });

  ws.on('message', (data) => {
    handleClientMessage(client, data.toString());
  });

  ws.on('close', () => {
    clients.delete(id);
    recomputeWsUnion();
    log.info('client disconnected', { clientId: id, clients: clients.size });
  });

  ws.on('error', (err) => {
    lastServerError = err.message;
    log.warn('client ws error', { clientId: id, error: err.message });
  });
}

function pruneStaleClients(): void {
  const now = Date.now();
  for (const [id, client] of clients) {
    if (now - client.lastPingAt > STALE_CLIENT_MS) {
      try { client.ws.terminate(); } catch { /* ignore */ }
      clients.delete(id);
    }
  }
  recomputeWsUnion();
}

export function startStreamServer(): ServerState {
  if (state.running) return state;
  if (isDisabled()) {
    log.info('stream server disabled via STREAM_WS_DISABLED');
    return state;
  }

  const port = defaultPort();

  try {
    wss = new WebSocketServer({ port, host: '0.0.0.0' });
  } catch (err) {
    lastServerError = err instanceof Error ? err.message : String(err);
    log.error('failed to bind WebSocket server', { port, error: lastServerError });
    return state;
  }

  wss.on('connection', (ws) => attachClient(ws));
  wss.on('error', (err) => {
    lastServerError = err.message;
    log.error('wss error', { error: err.message });
  });

  tickListener = (tick: MarketStreamTick) => broadcastTick(tick);
  tickBus.on(MARKET_TICK_EVENT, tickListener);

  fullSweepTimer = setInterval(broadcastFullUpdate, FULL_SWEEP_MS);
  heartbeatTimer = setInterval(pruneStaleClients, HEARTBEAT_MS);

  state = { running: true, port };
  log.info('stream server listening', { port });
  return state;
}

export function stopStreamServer(): void {
  if (tickListener) {
    tickBus.off(MARKET_TICK_EVENT, tickListener);
    tickListener = null;
  }
  if (fullSweepTimer) { clearInterval(fullSweepTimer); fullSweepTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }

  for (const client of clients.values()) {
    try { client.ws.close(); } catch { /* ignore */ }
  }
  clients.clear();
  recomputeWsUnion();

  if (wss) {
    try { wss.close(); } catch { /* ignore */ }
    wss = null;
  }
  state = { running: false, port: 0 };
}

export function getStreamServerStats() {
  return {
    running: state.running,
    port: state.port,
    clientCount: clients.size,
    cachedSymbols: latestBySymbol.size,
    ticksBroadcast,
    lastConnectedAt,
    reconnectAttempts,
    lastError: lastServerError,
  };
}

/** Legacy no-op kept for importers that seed Kite instrument maps. */
export async function seedKiteMapFromDaily(_s?: ServerState): Promise<number> {
  return 0;
}
