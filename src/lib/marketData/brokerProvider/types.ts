/**
 * Broker-neutral market-data provider contract (data-source path).
 *
 * Distinct from:
 *   - `@/providers/MarketDataProvider` — process-global facade (env MARKET_DATA_PROVIDER)
 *   - `@/lib/broker/adapter` — live trading (orders/positions)
 *   - `@/lib/broker/oauth` — OAuth login adapters only
 *
 * Adapters MUST map broker-native payloads internally and only return
 * the normalized types defined here. Callers never see Kite/Shoonya DTOs.
 */

import type { DataSourceBroker } from '@/lib/broker/connections/types';

/** Alias kept explicit for the Phase-2 contract naming. */
export type BrokerProviderName = DataSourceBroker;

export type BrokerMarketExchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'CDS' | 'MCX' | string;

export type BrokerInstrumentType =
  | 'EQ'
  | 'INDEX'
  | 'FUT'
  | 'CE'
  | 'PE'
  | 'ETF'
  | string;

/**
 * Per-request identity for a user's broker connection.
 * Tokens are NEVER placed on this object — adapters load/decrypt them
 * from `broker_connections` (or the shared Kite session for Zerodha).
 */
export interface BrokerConnectionContext {
  userId: number;
  /** Prefer this connection row; otherwise resolve primary for name+user. */
  connectionId?: string;
  requestId?: string;
  /** Optional wall-clock override for tests. */
  at?: Date;
}

/** Exchange + tradingsymbol identity shared by both brokers. */
export interface NormalizedInstrument {
  /** Canonical internal id, e.g. `NSE_EQ|RELIANCE`, `NSE_INDEX|NIFTY 50`, `NFO|NIFTY25JULFUT`. */
  instrumentKey: string;
  exchange: BrokerMarketExchange;
  symbol: string;
  instrumentType?: BrokerInstrumentType;
  name?: string | null;
}

/**
 * Loose input accepted by normalizeInstrument().
 * Callers may omit instrumentKey — it is derived from exchange/symbol/type.
 * Never pass Kite instrument_token or Shoonya exchange tokens here.
 */
export type NormalizedInstrumentInput = {
  instrumentKey?: string;
  exchange?: BrokerMarketExchange | string;
  symbol?: string;
  instrumentType?: BrokerInstrumentType | string;
  name?: string | null;
};

export interface NormalizedQuote {
  symbol: string;
  exchange: BrokerMarketExchange;
  ltp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  prevClose: number | null;
  volume: number | null;
  change: number | null;
  changePercent: number | null;
  /** Epoch ms */
  asOfMs: number;
  /** Adapter tag only — never a raw vendor payload */
  quality: 'live' | 'delayed' | 'stale' | 'unknown';
}

/**
 * Normalized live tick emitted by every BrokerMarketDataProvider.
 * Prefer this over broker-native tick DTOs (Kite wire ticks / Shoonya tk|tf).
 */
export interface NormalizedTick {
  provider: BrokerProviderName;
  userId: string;
  instrumentKey: string;
  exchange: string;
  symbol: string;
  brokerToken: string;
  lastPrice: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  bid?: number;
  ask?: number;
  exchangeTimestamp?: string;
  receivedAt: string;
}

export type NormalizedTickHandler = (tick: NormalizedTick) => void;

/** OHLCV bar in ascending time order (broker-neutral). */
export interface NormalizedCandle {
  /** ISO-8601 or `YYYY-MM-DD` for daily bars */
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BrokerCandleInterval =
  | '1minute'
  | '5minute'
  | '15minute'
  | '30minute'
  | '60minute'
  | 'day'
  | 'week'
  | 'month';

export interface HistoricalCandleRequest {
  instrument: NormalizedInstrument;
  interval: BrokerCandleInterval;
  /** Inclusive start (ISO or Date) */
  from: string | Date;
  /** Inclusive end (ISO or Date) */
  to: string | Date;
  /** Soft cap; adapters may return fewer bars */
  limit?: number;
}

export type ProviderConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'connected_no_data'
  | 'reconnecting'
  | 'expired'
  | 'error';

export interface ProviderConnectionStatus {
  broker: BrokerProviderName;
  state: ProviderConnectionState;
  /** True when the user has an active broker_connections row usable for market data */
  sessionActive: boolean;
  /** True when the live stream (if any) is up for this provider */
  streamConnected: boolean;
  lastTickAt: string | null;
  lastError: string | null;
  detail?: string | null;
}

export interface BrokerSession {
  broker: BrokerProviderName;
  userId: number;
  connectionId: string;
  accountId: string | null;
  expiresAt: string | null;
  refreshedAt: string;
}

/**
 * Required market-data capabilities for Zerodha and Shoonya.
 * Optional hooks (`refreshSession`, stream events) may grow later.
 */
export interface BrokerMarketDataProvider {
  readonly name: BrokerProviderName;

  connect(context: BrokerConnectionContext): Promise<void>;

  disconnect(context: BrokerConnectionContext): Promise<void>;

  isConnected(context: BrokerConnectionContext): boolean | Promise<boolean>;

  subscribe(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<void>;

  unsubscribe(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<void>;

  fetchQuote(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<NormalizedQuote[]>;

  fetchHistoricalCandles(
    context: BrokerConnectionContext,
    request: HistoricalCandleRequest,
  ): Promise<NormalizedCandle[]>;

  refreshSession?(
    context: BrokerConnectionContext,
  ): Promise<BrokerSession>;

  getStatus(
    context: BrokerConnectionContext,
  ): Promise<ProviderConnectionStatus>;

  /**
   * Subscribe to normalized live ticks for this provider.
   * Returns an unsubscribe function. Handlers never receive vendor DTOs.
   */
  onTick(handler: NormalizedTickHandler): () => void;
}

/** User-facing capability / capability-gap errors (no vendor bodies). */
export type BrokerMarketDataErrorCode =
  | 'not_connected'
  | 'session_expired'
  | 'not_implemented'
  | 'subscribe_failed'
  | 'quote_failed'
  | 'historical_failed'
  | 'instrument_unresolved'
  | 'provider_error';

export class BrokerMarketDataError extends Error {
  readonly code: BrokerMarketDataErrorCode;
  readonly broker: BrokerProviderName;

  constructor(
    broker: BrokerProviderName,
    code: BrokerMarketDataErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'BrokerMarketDataError';
    this.code = code;
    this.broker = broker;
  }
}
