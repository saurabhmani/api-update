// ════════════════════════════════════════════════════════════════
//  Kite Connect — service-layer types
//
//  Strongly typed shapes for raw Kite responses. These mirror the
//  Kite Connect v3 HTTP payloads and intentionally do NOT map into
//  app-level `@/types/market` types yet (Phase 2 scope).
// ════════════════════════════════════════════════════════════════

/** Exchange:tradingsymbol identifier used by quote / LTP / OHLC APIs. */
export type KiteInstrumentKey = string;

export type KiteExchange =
  | 'NSE'
  | 'BSE'
  | 'NFO'
  | 'CDS'
  | 'BCD'
  | 'BFO'
  | 'MCX';

export type KiteHistoricalInterval =
  | 'minute'
  | '3minute'
  | '5minute'
  | '10minute'
  | '15minute'
  | '30minute'
  | '60minute'
  | 'day';

export interface KiteDepthLevel {
  price: number;
  orders: number;
  quantity: number;
}

export interface KiteMarketDepth {
  buy: KiteDepthLevel[];
  sell: KiteDepthLevel[];
}

export interface KiteOHLCBlock {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Full quote payload for one instrument (`GET /quote`). */
export interface KiteQuote {
  instrument_token: number;
  timestamp: string;
  last_trade_time: string | null;
  last_price: number;
  volume: number;
  average_price: number;
  buy_quantity: number;
  sell_quantity: number;
  open_interest?: number;
  last_quantity: number;
  ohlc: KiteOHLCBlock;
  net_change: number;
  lower_circuit_limit: number;
  upper_circuit_limit: number;
  oi: number;
  oi_day_high: number;
  oi_day_low: number;
  depth: KiteMarketDepth;
}

export type KiteQuotesMap = Record<KiteInstrumentKey, KiteQuote>;

/** Compact LTP payload (`GET /quote/ltp`). */
export interface KiteLTP {
  instrument_token: number;
  last_price: number;
}

export type KiteLTPMap = Record<KiteInstrumentKey, KiteLTP>;

/** Compact OHLC payload (`GET /quote/ohlc`). */
export interface KiteOHLC {
  instrument_token: number;
  last_price: number;
  ohlc: KiteOHLCBlock;
}

export type KiteOHLCMap = Record<KiteInstrumentKey, KiteOHLC>;

/** One historical candle (`GET /instruments/historical/...`). */
export interface KiteHistoricalCandle {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

export interface KiteHistoricalParams {
  instrumentToken: number | string;
  interval: KiteHistoricalInterval;
  from: string | Date;
  to: string | Date;
  continuous?: boolean;
  oi?: boolean;
}

export type KiteInstrumentType = 'EQ' | 'FUT' | 'CE' | 'PE' | string;

/** Row from the instruments dump (`GET /instruments`). */
export interface KiteInstrument {
  instrument_token: string | number;
  exchange_token: string | number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: Date | string | null;
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: KiteInstrumentType;
  segment: string;
  exchange: KiteExchange | string;
}

export interface KiteProfile {
  user_id: string;
  user_name: string;
  user_shortname: string;
  email: string;
  user_type: string;
  broker: string;
  exchanges: string[];
  products: string[];
  order_types: string[];
  meta: {
    demat_consent: string;
  };
  avatar_url: string | null;
}

export interface KiteConnectionValidation {
  ok: boolean;
  profile: KiteProfile | null;
  error: string | null;
}

export interface KiteConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  redirectUrl: string;
}

export interface KiteApiErrorBody {
  status?: string;
  error_type?: string;
  message?: string;
  data?: unknown;
}
