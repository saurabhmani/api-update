// ════════════════════════════════════════════════════════════════
//  Canonical Market Data Types
//
//  Every adapter in /src/providers/adapters must return ONE of these
//  shapes. The provider layer (MarketDataProvider) wraps them in
//  ProviderResponse<T> before exposing to engines / API routes.
// ════════════════════════════════════════════════════════════════

// Architecture freeze (Priority 0):
//   IndianAPI  = PRIMARY live feed
//   Cache      = secondary (fresh cache layer)
//   Yahoo      = fallback ONLY
//   PostgreSQL = ONLY runtime DB (last-resort stale tier)
//   Kite       = broker/execution ONLY, NOT market-data truth
//
// The 'kite' enum value is retained so the execution module can keep
// tagging its internal records, but MarketDataProvider no longer
// returns source='kite' for any market-data read path.
export type ProviderSource =
  | 'indian'   // IndianAPI — PRIMARY
  | 'cache'    // in-memory snapshot within TTL
  | 'yahoo'    // Yahoo Finance fallback (15m delayed)
  | 'db'       // PostgreSQL last-known — flagged stale
  | 'kite';    // RESERVED for broker/execution tagging; never emitted by MarketDataProvider

export type DataQuality =
  | 'live'              // (deprecated market-data quality — retained for back-compat with broker-side tagging)
  | 'near-live'         // source=indian — REST, seconds-old
  | 'cached-fresh'      // source=cache, within TTL
  | 'fallback-delayed'  // source=yahoo (~15 min delayed)
  | 'stale';            // source=db (signal-critical callers MUST reject)

/** High-level role of the tier that served this response. */
export type ProviderSourceType =
  | 'primary'    // IndianAPI — PRIMARY source of truth
  | 'cache'      // hot cache between primary and fallback
  | 'fallback'   // Yahoo — delayed, used only when primary is unavailable
  | 'stale';     // persisted last-known value (PostgreSQL)

export interface MarketQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: number;
}

export interface MarketSnapshot extends MarketQuote {
  ltp: number;         // alias of price for platform consistency
  open: number;
  high: number;
  low: number;
  prevClose: number;
}

export interface HistoricalCandle {
  t: number;   // epoch ms of bar open
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface HistoricalSeries {
  symbol: string;
  range: HistoricalRange;
  candles: HistoricalCandle[];
}

export type HistoricalRange = '1d' | '5d' | '1mo' | '3mo' | '6mo' | '1y' | '5y';

export interface SymbolSearchHit {
  symbol: string;
  name: string;
  exchange?: string;
  type?: string;
}

export interface MoversBucket {
  symbol: string;
  price: number;
  changePercent: number;
}

export interface MoversResult {
  gainers: MoversBucket[];
  losers: MoversBucket[];
  mostActive: MoversBucket[];
}

export interface CorporateIntel {
  symbol: string;
  companyName: string;
  sector?: string;
  industry?: string;
  marketCap?: number;
  pe?: number;
  eps?: number;
  dividendYield?: number;
  bookValue?: number;
  roe?: number;
  debtToEquity?: number;
}

// Fundamentals — richer view than CorporateIntel, built for valuation
// overlays and long-horizon scoring per Phase-1 spec.
export interface Fundamentals {
  symbol: string;
  companyName: string;
  // Valuation
  pe?: number;
  pb?: number;              // price / book
  ps?: number;              // price / sales
  peg?: number;
  evToEbitda?: number;
  // Profitability
  roe?: number;
  roa?: number;
  roce?: number;
  netMargin?: number;       // %
  operatingMargin?: number; // %
  // Leverage
  debtToEquity?: number;
  interestCoverage?: number;
  // Growth
  revenueGrowthYoY?: number;   // %
  earningsGrowthYoY?: number;  // %
  // Dividends
  dividendYield?: number;
  payoutRatio?: number;
  // Forecasts + targets (flattened from analyst endpoints)
  analystTargetPrice?: number;
  analystRatingAvg?: number;   // 1.0 strong buy → 5.0 strong sell
  analystCount?: number;
  asOf: number;                // epoch ms
}

export interface IndustryPeer {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  marketCap?: number;
  pe?: number;
}

export interface ProviderResponse<T> {
  data: T;

  // ── Legacy fields (retained for back-compat with every call site in the app).
  //    New code should prefer the canonical fields below, but both are always populated.
  source: ProviderSource;
  data_quality: DataQuality;
  fetched_at: number;
  /** Populated only when MarketDataProvider had to walk the fallback
   *  chain — lists every provider tried and why it failed. Empty when
   *  the primary served the request. */
  trail?: Array<{ source: ProviderSource; ok: boolean; error?: string; ms?: number }>;

  // ── Canonical Phase-1 DoD fields (required by the architecture freeze).
  /** Human-readable vendor/tier name. E.g. 'IndianAPI', 'Cache', 'Yahoo Finance', 'PostgreSQL'. */
  provider_name: string;
  /** Role of the tier that served this response. */
  source_type: ProviderSourceType;
  /** Vendor-reported timestamp (epoch ms). Falls back to fetched_at when the upstream
   *  does not stamp its payload — freshness_ms will then be 0, which is honest. */
  vendor_timestamp: number;
  /** `fetched_at - vendor_timestamp`, clamped to >= 0. Lets callers apply freshness budgets. */
  freshness_ms: number;
  /** `null` when the primary (IndianAPI) served the request directly. Otherwise a
   *  short human-readable summary of why the chain had to walk past the primary. */
  fallback_reason: string | null;
}

/** Raised by MarketDataProvider when a signal-critical caller is
 *  served stale / fallback data and refuses to silently degrade. */
export class StaleDataError extends Error {
  constructor(public readonly response: ProviderResponse<unknown>) {
    super(
      `Signal-critical request served stale data: ` +
      `source=${response.source} quality=${response.data_quality}`,
    );
    this.name = 'StaleDataError';
  }
}
