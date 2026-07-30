import { createHash } from 'node:crypto';

const KEY_ROOT = 'q365';
const KEY_VERSION = process.env.CACHE_KEY_VERSION?.trim() || 'v1';
const ENVIRONMENT =
  process.env.CACHE_ENV_PREFIX?.trim().toLowerCase()
  || process.env.NODE_ENV?.trim().toLowerCase()
  || 'development';

const FORBIDDEN_COMPONENT_NAME =
  /(?:cookie|password|passwd|mfa|totp|secret|access[-_]?token|refresh[-_]?token|api[-_]?key|encryption[-_]?key|session[-_]?token)/i;
const TOKEN_LIKE_VALUE = /^(?:bearer\s+)?[A-Za-z0-9+/_=-]{40,}$/i;

export type CacheKeyComponent = string | number | boolean;

function sanitizeComponent(value: CacheKeyComponent, label = 'component'): string {
  const raw = String(value).trim();
  if (!raw) throw new Error(`Cache key ${label} cannot be empty`);
  if (FORBIDDEN_COMPONENT_NAME.test(label) || FORBIDDEN_COMPONENT_NAME.test(raw)) {
    throw new Error(`Sensitive ${label} cannot be used in a cache key`);
  }
  if (TOKEN_LIKE_VALUE.test(raw)) {
    throw new Error(`Token-like ${label} cannot be used in a cache key`);
  }
  return encodeURIComponent(raw.replace(/:/g, '-'));
}

function opaqueScope(value: string | number): string {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function cacheKey(
  domain: CacheKeyComponent,
  resource: CacheKeyComponent,
  ...scope: CacheKeyComponent[]
): string {
  return [
    KEY_ROOT,
    sanitizeComponent(KEY_VERSION, 'version'),
    sanitizeComponent(ENVIRONMENT, 'environment'),
    sanitizeComponent(domain, 'domain'),
    sanitizeComponent(resource, 'resource'),
    ...scope.map((part) => sanitizeComponent(part)),
  ].join(':');
}

export function cachePattern(
  domain: CacheKeyComponent,
  resource: CacheKeyComponent | '*',
  ...scope: Array<CacheKeyComponent | '*'>
): string {
  const safe = (part: CacheKeyComponent | '*') =>
    part === '*' ? '*' : sanitizeComponent(part);
  return [
    KEY_ROOT,
    sanitizeComponent(KEY_VERSION, 'version'),
    sanitizeComponent(ENVIRONMENT, 'environment'),
    sanitizeComponent(domain, 'domain'),
    safe(resource),
    ...scope.map(safe),
  ].join(':');
}

export const cacheKeys = {
  marketQuote: (symbol: string) =>
    cacheKey('market', 'quote', symbol.trim().toUpperCase()),
  signalsList: (userId: string | number, window: string) =>
    cacheKey('signals', 'list', `user-${opaqueScope(userId)}`, window),
  portfolioSummary: (userId: string | number) =>
    cacheKey('portfolio', 'summary', `user-${opaqueScope(userId)}`),
  dashboardSummary: (userId: string | number) =>
    cacheKey('dashboard', 'summary', `user-${opaqueScope(userId)}`),
  tickerStrip: () => cacheKey('market', 'ticker-strip', 'NSE'),
  rankingsList: (limit: number, page: number, exchange?: string) =>
    cacheKey('rankings', 'list', exchange || 'ALL', limit, page),
  tradeSetupResult: (userId: string | number, symbol: string) =>
    cacheKey(
      'trade-setup',
      'result',
      `user-${opaqueScope(userId)}`,
      symbol.trim().toUpperCase(),
    ),
  tradeSetupGeneration: (
    userId: string | number,
    strategy: string,
    timeframe: string,
    marketContext: string,
  ) => cacheKey(
    'trade-setup',
    'generation',
    `user-${opaqueScope(userId)}`,
    strategy,
    timeframe,
    marketContext,
  ),
  tradeSetupGenerationLock: (
    strategy: string,
    timeframe: string,
    marketContext: string,
  ) => cacheKey(
    'trade-setup',
    'generation-lock',
    strategy,
    timeframe,
    marketContext,
  ),
  tradeSetupGenerationResult: (
    userId: string | number,
    symbol: string,
    strategy: string,
    timeframe: string,
    marketContext: string,
    strategyVersion: string,
    freshnessVersion: string,
  ) => cacheKey(
    'trade-setup',
    'result',
    `user-${opaqueScope(userId)}`,
    symbol.trim().toUpperCase(),
    strategy,
    timeframe,
    marketContext,
    strategyVersion,
    freshnessVersion,
  ),
  tradeSetupRequestLock: (
    userId: string | number,
    symbol: string,
    strategy: string,
    timeframe: string,
  ) => cacheKey(
    'lock',
    'trade-setup',
    `user-${opaqueScope(userId)}`,
    symbol.trim().toUpperCase(),
    strategy,
    timeframe,
  ),
  symbolWindow: (
    domain: string,
    resource: string,
    symbol: string,
    window: string,
  ) => cacheKey(domain, resource, symbol.trim().toUpperCase(), window),
  userPattern: (domain: string, resource: string, userId: string | number) =>
    `${cachePattern(domain, resource, `user-${opaqueScope(userId)}`)}*`,
  userDomainPattern: (domain: string, userId: string | number) =>
    `${cachePattern(domain, '*', `user-${opaqueScope(userId)}`)}*`,
  symbolPattern: (domain: string, resource: string, symbol: string) =>
    `${cachePattern(domain, resource, symbol.trim().toUpperCase())}*`,
};

export function getCacheKeyPrefix(): string {
  return [KEY_ROOT, KEY_VERSION, ENVIRONMENT].join(':');
}
