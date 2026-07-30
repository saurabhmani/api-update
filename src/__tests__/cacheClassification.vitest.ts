import { describe, expect, it } from 'vitest';
import {
  classifyApiCachePolicy,
  IDEMPOTENT_CALCULATION_POST_RULES,
} from '@/lib/cache/cacheClassification';
import { CACHE_TTL } from '@/lib/cache/cachePolicy';

describe('API cache policy classification', () => {
  it('publishes explicit domain TTLs', () => {
    expect(CACHE_TTL).toMatchObject({
      MARKET_QUOTE: 5,
      MARKET_SNAPSHOT: 15,
      MARKET_OVERVIEW: 30,
      STOCK_DETAILS: 60,
      SIGNALS_LIST: 30,
      RANKINGS: 60,
      NEWS_LIST: 120,
      TRADE_SETUP: 30,
      DASHBOARD_SUMMARY: 30,
      PORTFOLIO_SUMMARY: 15,
      STATIC_REFERENCE: 3600,
    });
  });

  it.each([
    ['/api/market/quote', 'marketQuote', 'global'],
    ['/api/market', 'marketOverview', 'global'],
    ['/api/stocks/RELIANCE', 'stockDetails', 'global'],
    ['/api/rankings', 'rankings', 'global'],
    ['/api/news', 'newsList', 'global'],
    ['/api/health', 'healthSummary', 'public'],
    ['/api/openapi', 'staticReference', 'public'],
  ])('classifies global/public GET %s', (route, policyName, scope) => {
    expect(classifyApiCachePolicy(route, 'GET')).toMatchObject({
      cacheable: true,
      policyName,
      scope,
    });
  });

  it.each([
    ['/api/portfolio/overview', 'portfolioSummary'],
    ['/api/paper-trading/account', 'paperTrading'],
    ['/api/watchlist', 'watchlist'],
    ['/api/user', 'userSettings'],
    ['/api/subscription', 'subscriptionSummary'],
    ['/api/signals', 'personalizedSignals'],
    ['/api/trade-setups', 'tradeSetup'],
    ['/api/dashboard', 'dashboardSummary'],
  ])('requires user-scoped caching for %s', (route, policyName) => {
    expect(classifyApiCachePolicy(route, 'GET')).toMatchObject({
      cacheable: true,
      policyName,
      scope: 'user',
    });
  });

  it.each([
    ['/api/auth/mfa', 'POST'],
    ['/api/kite/auth/callback', 'GET'],
    ['/api/brokers/shoonya/callback', 'GET'],
    ['/api/broker/order', 'POST'],
    ['/api/live-trading/order', 'POST'],
    ['/api/broker/kill-switch', 'POST'],
    ['/api/wallet/recharge', 'POST'],
    ['/api/billing/upgrade', 'POST'],
    ['/api/admin/recompute', 'POST'],
  ])('does not cache sensitive or mutating endpoint %s %s', (route, method) => {
    expect(classifyApiCachePolicy(route, method).cacheable).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'denies %s mutation responses without an explicit exception',
    (method) => {
      expect(classifyApiCachePolicy('/api/watchlist', method)).toMatchObject({
        cacheable: false,
        scope: 'none',
      });
    },
  );

  it('has no unproven cacheable POST calculations', () => {
    expect(IDEMPOTENT_CALCULATION_POST_RULES).toEqual([]);
    expect(classifyApiCachePolicy('/api/portfolio/optimize', 'POST')).toMatchObject({
      cacheable: false,
      reason: 'POST is not an approved idempotent calculation',
    });
  });

  it('defaults unclassified reads to no-store', () => {
    expect(classifyApiCachePolicy('/api/admin/system-health', 'GET')).toMatchObject({
      cacheable: false,
      policy: null,
    });
  });
});
