// ════════════════════════════════════════════════════════════════
//  IndianAPI raw response models — INTERNAL to the provider layer.
//
//  These shapes mirror the vendor payloads only enough to extract
//  the fields the mappers reference. They must NEVER be imported by
//  engines, services, or API routes — the mappers in
//  indianApiMappers.ts convert them to the canonical types in
//  src/types/market.ts and only those leave the provider layer.
// ════════════════════════════════════════════════════════════════

/** GET /stock?name=<symbol> */
export interface RawIndianApiStock {
  companyName?: string;
  tickerId?: string;
  currentPrice?: { BSE?: string | number; NSE?: string | number };
  percentChange?: string | number;
  yearHigh?: string | number;
  yearLow?: string | number;
  dayHigh?: string | number;
  dayLow?: string | number;
  volume?: string | number;
  open?: string | number;
  previousClose?: string | number;
  // Profile / fundamentals fields returned by the same endpoint
  industry?: string;
  sector?: string;
  marketCap?: string | number;
  peRatio?: string | number;
  eps?: string | number;
  dividendYield?: string | number;
  bookValue?: string | number;
  roe?: string | number;
  debtToEquity?: string | number;
}

/** POST /nse_stock_batch_live_price — keyed by symbol or array form. */
export interface RawIndianApiBatchQuoteItem {
  symbol?: string;
  tickerId?: string;
  price?: string | number;
  lastPrice?: string | number;
  currentPrice?: { BSE?: string | number; NSE?: string | number } | string | number;
  percentChange?: string | number;
  volume?: string | number;
  open?: string | number;
  dayHigh?: string | number;
  dayLow?: string | number;
  previousClose?: string | number;
}

/** GET /historical_data?stock_name=&period=&filter=price */
export interface RawIndianApiHistorical {
  datasets?: Array<{
    metric?: string;
    label?: string;
    values?: Array<[string, string | number] | { date?: string; value?: string | number }>;
  }>;
}

/** GET /trending */
export interface RawIndianApiTrending {
  trending_stocks?: {
    top_gainers?: RawIndianApiMoverItem[];
    top_losers?: RawIndianApiMoverItem[];
  };
}

export interface RawIndianApiMoverItem {
  ticker_id?: string;
  ric?: string;
  symbol?: string;
  company_name?: string;
  price?: string | number;
  percent_change?: string | number;
  net_change?: string | number;
  volume?: string | number;
}

/** GET /NSE_most_active — array of mover-like items. */
export type RawIndianApiMostActive = RawIndianApiMoverItem[];

/** GET /usage */
export interface RawIndianApiUsage {
  credits_used?: number;
  credits_remaining?: number;
  plan?: string;
  [key: string]: unknown;
}
