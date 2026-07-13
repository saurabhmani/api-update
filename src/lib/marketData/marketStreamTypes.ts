// Shared types for the live market WebSocket stream (server + browser).

export interface MarketStreamTick {
  symbol:   string;
  price:    number;
  change:   number | null;
  pChange:  number | null;
  open?:    number | null;
  high?:    number | null;
  low?:     number | null;
  close?:   number | null;
  volume?:  number | null;
  bid?:     number | null;
  ask?:     number | null;
  source:   string;
  ts:       number;
}

/** Browser connection lifecycle exposed to UI badges. */
export type MarketStreamStatus =
  | 'connected'
  | 'connecting'
  | 'reconnecting'
  | 'disconnected';

/** Inbound frames the browser may send. */
export type MarketStreamClientMessage =
  | { type: 'subscribe';   symbols: string[] }
  | { type: 'unsubscribe'; symbols: string[] }
  | { type: 'ping' };

/** Outbound frames the server may push. */
export type MarketStreamServerMessage =
  | { type: 'connected'; serverNow: number; clientId: string }
  | { type: 'tick';      data: MarketStreamTick }
  | { type: 'prices';    data: MarketStreamTick[] }
  | { type: 'FULL_UPDATE'; data: MarketStreamTick[] }
  | { type: 'pong';      serverNow: number }
  | { type: 'error';     message: string };

export const MARKET_TICK_EVENT = 'market_tick' as const;
