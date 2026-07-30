import { cacheKeys, cachePattern } from './cacheKeys';
import { cacheService } from './cacheService';

export type CacheMutationDomain =
  | 'signal-generated'
  | 'signal-promoted'
  | 'portfolio-mutated'
  | 'paper-order-mutated'
  | 'strategy-mutated'
  | 'market-reference-mutated'
  | 'news-ingested'
  | 'user-settings-mutated';

export const CACHE_INVALIDATION_DEPENDENCIES: Record<
  CacheMutationDomain,
  readonly string[]
> = {
  'signal-generated': [
    'signals',
    'rankings',
    'dashboard',
    'trade-setup',
    'ticker',
  ],
  'signal-promoted': ['signals', 'rankings', 'dashboard', 'ticker'],
  'portfolio-mutated': ['portfolio', 'trade-setup', 'dashboard'],
  'paper-order-mutated': ['paper-trading', 'portfolio', 'dashboard'],
  'strategy-mutated': ['strategies', 'strategy-analytics', 'dashboard'],
  'market-reference-mutated': [
    'market',
    'stock-details',
    'rankings',
    'ticker',
    'dashboard',
  ],
  'news-ingested': ['news', 'intelligence', 'dashboard'],
  'user-settings-mutated': [
    'user',
    'signals',
    'trade-setup',
    'dashboard',
  ],
};

async function deletePatterns(patterns: string[]): Promise<number> {
  const unique = [...new Set(patterns)];
  const counts = await Promise.all(
    unique.map((pattern) => cacheService.deleteByPattern(pattern)),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}

function legacyUserScope(userId: string | number): string | null {
  const value = String(userId);
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export async function invalidateResource(
  domain: string,
  resource: string,
): Promise<number> {
  return cacheService.deleteByPattern(cachePattern(domain, resource, '*'));
}

export async function invalidateDomain(domain: string): Promise<number> {
  return cacheService.deleteByPattern(cachePattern(domain, '*'));
}

export async function invalidateUserResource(
  domain: string,
  resource: string,
  userId: string | number,
): Promise<number> {
  return cacheService.deleteByPattern(
    cacheKeys.userPattern(domain, resource, userId),
  );
}

export async function invalidateSymbolResource(
  domain: string,
  resource: string,
  symbol: string,
): Promise<number> {
  return cacheService.deleteByPattern(
    cacheKeys.symbolPattern(domain, resource, symbol),
  );
}

export async function invalidateSignalGeneratedCaches(): Promise<number> {
  return deletePatterns([
    cachePattern('signals', '*'),
    cachePattern('rankings', '*'),
    cachePattern('dashboard', 'summary', '*'),
    cachePattern('trade-setup', '*'),
    cachePattern('market', 'ticker-strip', '*'),
    'signal:*',
    'signals:*',
    'confirmed:*',
    'rankings:top:*',
    'ticker:strip',
  ]);
}

export async function invalidateSignalPromotedCaches(): Promise<number> {
  return deletePatterns([
    cachePattern('signals', '*'),
    cachePattern('rankings', '*'),
    cachePattern('dashboard', 'summary', '*'),
    cachePattern('market', 'ticker-strip', '*'),
    'signal:*',
    'signals:*',
    'confirmed:*',
    'rankings:top:*',
    'ticker:strip',
  ]);
}

export async function invalidatePortfolioCaches(
  userId: string | number,
): Promise<number> {
  const legacy = legacyUserScope(userId);
  return deletePatterns([
    cacheKeys.userDomainPattern('portfolio', userId),
    cacheKeys.userDomainPattern('trade-setup', userId),
    cacheKeys.userDomainPattern('dashboard', userId),
    ...(legacy ? [`portfolio:context:${legacy}`, `portfolio:*:${legacy}`] : []),
  ]);
}

export async function invalidatePaperTradingCaches(
  userId: string | number,
): Promise<number> {
  const legacy = legacyUserScope(userId);
  return deletePatterns([
    cacheKeys.userDomainPattern('paper', userId),
    cacheKeys.userDomainPattern('paper-trading', userId),
    cacheKeys.userDomainPattern('portfolio', userId),
    cacheKeys.userDomainPattern('dashboard', userId),
    ...(legacy ? [`paper:*:${legacy}`, `paper-trading:*:${legacy}`] : []),
  ]);
}

export async function invalidateStrategyCaches(
  strategyId?: string | number,
): Promise<number> {
  const scope = strategyId == null ? '*' : String(strategyId);
  return deletePatterns([
    strategyId == null
      ? cachePattern('strategies', '*')
      : `${cachePattern('strategies', '*', scope)}*`,
    strategyId == null
      ? cachePattern('strategy-analytics', '*')
      : `${cachePattern('strategy-analytics', '*', scope)}*`,
    cachePattern('dashboard', 'summary', '*'),
    `strategy:*:${scope}`,
    `strategy-analytics:*:${scope}`,
  ]);
}

export async function invalidateMarketReferenceCaches(
  symbol?: string,
): Promise<number> {
  const normalized = symbol?.trim().toUpperCase();
  const symbolScope = normalized || '*';
  return deletePatterns([
    normalized
      ? `${cachePattern('market', '*', symbolScope)}*`
      : cachePattern('market', '*'),
    normalized
      ? `${cachePattern('stock', '*', symbolScope)}*`
      : cachePattern('stock', '*'),
    cachePattern('rankings', '*'),
    cachePattern('dashboard', 'summary', '*'),
    cachePattern('market', 'ticker-strip', '*'),
    `stock:${symbolScope}`,
    `quote:${symbolScope}`,
    `detail:${symbolScope}:*`,
    `hist:${symbolScope}:*`,
    'rankings:top:*',
    'ticker:strip',
  ]);
}

export async function invalidateNewsCaches(): Promise<number> {
  return deletePatterns([
    cachePattern('news', '*'),
    cachePattern('intelligence', '*'),
    cachePattern('dashboard', 'summary', '*'),
    'news:*',
    'rss:*',
    'market:intelligence',
    'scenario:current',
    'market:stance',
  ]);
}

export async function invalidateUserSettingsCaches(
  userId: string | number,
): Promise<number> {
  const legacy = legacyUserScope(userId);
  return deletePatterns([
    cacheKeys.userDomainPattern('user', userId),
    cacheKeys.userDomainPattern('signals', userId),
    cacheKeys.userDomainPattern('trade-setup', userId),
    cacheKeys.userDomainPattern('dashboard', userId),
    ...(legacy ? [`preferences:${legacy}`, `personalized:*:${legacy}`] : []),
  ]);
}
