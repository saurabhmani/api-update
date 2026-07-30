export interface CachePolicy {
  /** Fresh lifetime. Must be a positive whole number of seconds. */
  ttlSeconds: number;
  /**
   * Additional lifetime during which stale data may be returned while one
   * request refreshes it in the background.
   */
  staleWhileRevalidateSeconds?: number;
  /** Cache a loader result of null. Defaults to false. */
  cacheNull?: boolean;
}

export const CACHE_TTL = {
  MARKET_QUOTE: 5,
  MARKET_SNAPSHOT: 15,
  MARKET_OVERVIEW: 30,
  TICKER_STRIP: 30,
  TICKER_STRIP_DEGRADED: 10,
  STOCK_DETAILS: 60,
  MARKET_STATUS: 30,
  SIGNALS_LIST: 30,
  PERSONALIZED_SIGNALS: 30,
  RANKINGS: 60,
  NEWS_LIST: 120,
  NEWS_FEED: 5 * 60,
  NEWS_SYMBOL_FRESH: 6 * 60 * 60,
  NEWS_SYMBOL_STALE: 7 * 24 * 60 * 60,
  TRADE_SETUP: 30,
  DASHBOARD_SUMMARY: 30,
  STRATEGY_SUMMARY: 60,
  HEALTH_SUMMARY: 15,
  PORTFOLIO_SUMMARY: 15,
  PAPER_TRADING: 15,
  WATCHLIST: 30,
  USER_SETTINGS: 300,
  SUBSCRIPTION_SUMMARY: 60,
  USAGE_SUMMARY: 60,
  STATIC_REFERENCE: 60 * 60,
  MARKET_REGIME_ADMIN_OVERRIDE: 2 * 60 * 60,
  REDIS_HEALTH_PROBE: 10,
  HISTORICAL_CANDLES: 24 * 60 * 60,
} as const;

export const CACHE_POLICIES = {
  marketQuote: {
    ttlSeconds: CACHE_TTL.MARKET_QUOTE,
    staleWhileRevalidateSeconds: 5,
  },
  marketSnapshot: {
    ttlSeconds: CACHE_TTL.MARKET_SNAPSHOT,
    staleWhileRevalidateSeconds: 15,
  },
  marketOverview: {
    ttlSeconds: CACHE_TTL.MARKET_OVERVIEW,
    staleWhileRevalidateSeconds: 30,
  },
  stockDetails: {
    ttlSeconds: CACHE_TTL.STOCK_DETAILS,
    staleWhileRevalidateSeconds: 60,
  },
  marketStatus: { ttlSeconds: CACHE_TTL.MARKET_STATUS, staleWhileRevalidateSeconds: 30 },
  signalsList: {
    ttlSeconds: CACHE_TTL.SIGNALS_LIST,
    staleWhileRevalidateSeconds: 30,
  },
  personalizedSignals: { ttlSeconds: CACHE_TTL.PERSONALIZED_SIGNALS },
  rankings: {
    ttlSeconds: CACHE_TTL.RANKINGS,
    staleWhileRevalidateSeconds: 60,
  },
  newsList: {
    ttlSeconds: CACHE_TTL.NEWS_LIST,
    staleWhileRevalidateSeconds: 120,
  },
  tradeSetup: { ttlSeconds: CACHE_TTL.TRADE_SETUP },
  dashboardSummary: {
    ttlSeconds: CACHE_TTL.DASHBOARD_SUMMARY,
    staleWhileRevalidateSeconds: 30,
  },
  strategySummary: {
    ttlSeconds: CACHE_TTL.STRATEGY_SUMMARY,
    staleWhileRevalidateSeconds: 60,
  },
  healthSummary: {
    ttlSeconds: CACHE_TTL.HEALTH_SUMMARY,
    staleWhileRevalidateSeconds: 15,
  },
  portfolioSummary: { ttlSeconds: CACHE_TTL.PORTFOLIO_SUMMARY },
  paperTrading: { ttlSeconds: CACHE_TTL.PAPER_TRADING },
  watchlist: { ttlSeconds: CACHE_TTL.WATCHLIST },
  userSettings: { ttlSeconds: CACHE_TTL.USER_SETTINGS },
  subscriptionSummary: { ttlSeconds: CACHE_TTL.SUBSCRIPTION_SUMMARY },
  usageSummary: { ttlSeconds: CACHE_TTL.USAGE_SUMMARY },
  staticReference: {
    ttlSeconds: CACHE_TTL.STATIC_REFERENCE,
    staleWhileRevalidateSeconds: CACHE_TTL.STATIC_REFERENCE,
  },
  historicalCandles: { ttlSeconds: CACHE_TTL.HISTORICAL_CANDLES },
} satisfies Record<string, CachePolicy>;

export type CachePolicyName = keyof typeof CACHE_POLICIES;

const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

export function normalizeCachePolicy(
  policy: CachePolicy | number,
): Required<CachePolicy> {
  const input = typeof policy === 'number' ? { ttlSeconds: policy } : policy;
  const ttlSeconds = Math.floor(Number(input.ttlSeconds));
  const staleSeconds = Math.floor(Number(input.staleWhileRevalidateSeconds ?? 0));

  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(`Cache TTL must be between 1 and ${MAX_TTL_SECONDS} seconds`);
  }
  if (!Number.isFinite(staleSeconds) || staleSeconds < 0 || staleSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(`Cache stale TTL must be between 0 and ${MAX_TTL_SECONDS} seconds`);
  }

  return {
    ttlSeconds,
    staleWhileRevalidateSeconds: staleSeconds,
    cacheNull: input.cacheNull === true,
  };
}
