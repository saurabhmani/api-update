import {
  CACHE_POLICIES,
  CachePolicy,
  CachePolicyName,
} from './cachePolicy';

export type CacheScope = 'global' | 'public' | 'user';
export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

export interface ApiCacheDecision {
  cacheable: boolean;
  scope: CacheScope | 'none';
  policyName: CachePolicyName | null;
  policy: CachePolicy | null;
  reason: string;
}

interface CacheableRouteRule {
  pattern: string;
  scope: CacheScope;
  policyName: CachePolicyName;
}

/**
 * Authentication, credentials and financial mutation routes stay no-store
 * even if a future broad read rule overlaps them.
 */
export const NEVER_CACHE_ROUTE_PREFIXES = [
  '/api/auth',
  '/api/login',
  '/api/logout',
  '/api/register',
  '/api/password',
  '/api/security/mfa',
  '/api/kite/auth',
  '/api/kite/session',
  '/api/broker/auth',
  '/api/broker/connect',
  '/api/broker/disconnect',
  '/api/brokers/zerodha/connect',
  '/api/brokers/shoonya/connect',
  '/api/brokers/shoonya/callback',
  '/api/broker/order',
  '/api/live-trading/order',
  '/api/live-trading/deploy',
  '/api/broker/kill-switch',
  '/api/paper-trading/kill-switch',
  '/api/wallet/recharge',
  '/api/billing/wallet/recharge',
  '/api/billing/subscribe',
  '/api/billing/upgrade',
  '/api/subscription/upgrade',
] as const;

/**
 * Read classifications are explicit and ordered from narrow/user-specific to
 * broader global routes. `/**` means the route and all descendants.
 */
export const CACHEABLE_GET_ROUTE_RULES: readonly CacheableRouteRule[] = [
  { pattern: '/api/portfolio/**', scope: 'user', policyName: 'portfolioSummary' },
  { pattern: '/api/paper/**', scope: 'user', policyName: 'paperTrading' },
  { pattern: '/api/paper-trading/**', scope: 'user', policyName: 'paperTrading' },
  { pattern: '/api/watchlist/**', scope: 'user', policyName: 'watchlist' },
  { pattern: '/api/user/**', scope: 'user', policyName: 'userSettings' },
  { pattern: '/api/subscription', scope: 'user', policyName: 'subscriptionSummary' },
  { pattern: '/api/billing/subscription', scope: 'user', policyName: 'subscriptionSummary' },
  { pattern: '/api/billing/usage/**', scope: 'user', policyName: 'usageSummary' },
  { pattern: '/api/usage', scope: 'user', policyName: 'usageSummary' },
  { pattern: '/api/signals/**', scope: 'user', policyName: 'personalizedSignals' },
  { pattern: '/api/trade-setups/**', scope: 'user', policyName: 'tradeSetup' },
  { pattern: '/api/dashboard', scope: 'user', policyName: 'dashboardSummary' },
  { pattern: '/api/trust/dashboard', scope: 'user', policyName: 'dashboardSummary' },
  { pattern: '/api/stocks/**', scope: 'global', policyName: 'stockDetails' },
  { pattern: '/api/market/quote', scope: 'global', policyName: 'marketQuote' },
  { pattern: '/api/market/v2/quote', scope: 'global', policyName: 'marketQuote' },
  { pattern: '/api/price', scope: 'global', policyName: 'marketQuote' },
  { pattern: '/api/market/snapshot-db', scope: 'global', policyName: 'marketSnapshot' },
  { pattern: '/api/market-data/unified', scope: 'global', policyName: 'marketSnapshot' },
  { pattern: '/api/market', scope: 'global', policyName: 'marketOverview' },
  { pattern: '/api/market/movers', scope: 'global', policyName: 'marketOverview' },
  { pattern: '/api/market-regime', scope: 'global', policyName: 'marketOverview' },
  { pattern: '/api/market-status', scope: 'global', policyName: 'marketStatus' },
  { pattern: '/api/ticker', scope: 'global', policyName: 'marketOverview' },
  { pattern: '/api/rankings/**', scope: 'global', policyName: 'rankings' },
  { pattern: '/api/opportunities/ranked', scope: 'global', policyName: 'rankings' },
  { pattern: '/api/news/**', scope: 'global', policyName: 'newsList' },
  { pattern: '/api/news-engine', scope: 'global', policyName: 'newsList' },
  { pattern: '/api/strategies/metrics', scope: 'global', policyName: 'strategySummary' },
  { pattern: '/api/strategies/performance', scope: 'global', policyName: 'strategySummary' },
  { pattern: '/api/strategies/categories', scope: 'global', policyName: 'strategySummary' },
  { pattern: '/api/health', scope: 'public', policyName: 'healthSummary' },
  { pattern: '/api/engine-health/**', scope: 'global', policyName: 'healthSummary' },
  { pattern: '/api/market-data/health', scope: 'global', policyName: 'healthSummary' },
  { pattern: '/api/data-feed/health', scope: 'global', policyName: 'healthSummary' },
  { pattern: '/api/billing/plans', scope: 'public', policyName: 'staticReference' },
  { pattern: '/api/canonical/benchmarks', scope: 'global', policyName: 'staticReference' },
  { pattern: '/api/canonical/factors', scope: 'global', policyName: 'staticReference' },
  { pattern: '/api/canonical/instruments', scope: 'global', policyName: 'staticReference' },
  { pattern: '/api/canonical/sectors', scope: 'global', policyName: 'staticReference' },
  { pattern: '/api/openapi', scope: 'public', policyName: 'staticReference' },
] as const;

/**
 * Cacheable POST responses must be proven idempotent and side-effect free.
 * Keep the allowlist explicit; an empty list is safer than route-name
 * inference. Add entries only with a test proving no DB/provider mutation.
 */
export const IDEMPOTENT_CALCULATION_POST_RULES: readonly CacheableRouteRule[] = [];

function matchesRoute(pattern: string, route: string): boolean {
  if (!pattern.endsWith('/**')) return pattern === route;
  const prefix = pattern.slice(0, -3);
  return route === prefix || route.startsWith(`${prefix}/`);
}

function noCache(reason: string): ApiCacheDecision {
  return {
    cacheable: false,
    scope: 'none',
    policyName: null,
    policy: null,
    reason,
  };
}

export function classifyApiCachePolicy(
  route: string,
  method: HttpMethod | string,
): ApiCacheDecision {
  const normalizedRoute = `/${route.trim().replace(/^\/+|\/+$/g, '')}`;
  const normalizedMethod = method.toUpperCase();

  if (NEVER_CACHE_ROUTE_PREFIXES.some((prefix) =>
    normalizedRoute === prefix || normalizedRoute.startsWith(`${prefix}/`)
  )) {
    return noCache('security, credential, payment, broker or trading route');
  }

  if (normalizedMethod === 'POST') {
    const calculation = IDEMPOTENT_CALCULATION_POST_RULES.find((rule) =>
      matchesRoute(rule.pattern, normalizedRoute)
    );
    if (!calculation) {
      return noCache('POST is not an approved idempotent calculation');
    }
    return {
      cacheable: true,
      scope: calculation.scope,
      policyName: calculation.policyName,
      policy: CACHE_POLICIES[calculation.policyName],
      reason: 'reviewed idempotent calculation allowlist',
    };
  }

  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
    return noCache(`${normalizedMethod} mutation responses are no-store by default`);
  }

  const rule = CACHEABLE_GET_ROUTE_RULES.find((candidate) =>
    matchesRoute(candidate.pattern, normalizedRoute)
  );
  if (!rule) return noCache('no explicit cache policy classification');

  return {
    cacheable: true,
    scope: rule.scope,
    policyName: rule.policyName,
    policy: CACHE_POLICIES[rule.policyName],
    reason: 'explicit read-route classification',
  };
}
