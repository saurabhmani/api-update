// ════════════════════════════════════════════════════════════════
//  Multi-Source Ingestion Orchestrator
//
//  Calls all adapters in parallel, collects RawNewsItem[],
//  returns deduplicated aggregate for normalization.
//
//  Adapters grouped by source class:
//    official - exchange announcements, corporate filings
//    media    - GNews, NewsData, RSS feeds, Finnhub
//    deals    - M&A, fundraising, contracts
//    social   - social/newswire sentiment signals
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem, NewsSourceId, NewsSourceClass } from '../types/newsEngine.types';
import { SOURCE_CLASS_MAP } from '../types/newsEngine.types';
import { gnewsAdapter } from './gnewsAdapter';
import { newsDataAdapter } from './newsDataAdapter';
import { rssEtAdapter, rssMcAdapter } from './rssAdapter';
import { finnhubAdapter } from './finnhubAdapter';
import { officialExchangeAdapter, corporateFilingsAdapter } from './officialExchangeAdapter';
import { dealsFeedAdapter } from './dealsFeedAdapter';
import { socialSignalsAdapter } from './socialSignalsAdapter';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'newsIngestion' });

const ALL_ADAPTERS: NewsAdapter[] = [
  // Official sources (highest credibility)
  officialExchangeAdapter,
  corporateFilingsAdapter,
  // Media sources (standard credibility)
  gnewsAdapter,
  newsDataAdapter,
  rssEtAdapter,
  rssMcAdapter,
  finnhubAdapter,
  // Deals sources (high impact events)
  dealsFeedAdapter,
  // Social sources (lower credibility, higher manipulation scrutiny)
  socialSignalsAdapter,
];

export interface RawIngestionResult {
  items: RawNewsItem[];
  sourceBreakdown: Record<NewsSourceId, number>;
  /** Coverage by source class — which classes returned data. */
  sourceClassCoverage: Record<NewsSourceClass, { attempted: number; succeeded: number; itemCount: number }>;
  errors: string[];
}

/**
 * Fetch from all configured news sources in parallel.
 *
 * @param query  - Search query (e.g. "Indian stock market")
 * @param limit  - Per-source limit
 */
export async function ingestFromAllSources(
  query = 'Indian stock market NSE',
  limit = 15,
): Promise<RawIngestionResult> {
  const sourceBreakdown = {} as Record<NewsSourceId, number>;
  const errors: string[] = [];

  // Track per-class coverage
  const classCoverage: Record<NewsSourceClass, { attempted: number; succeeded: number; itemCount: number }> = {
    official: { attempted: 0, succeeded: 0, itemCount: 0 },
    media:    { attempted: 0, succeeded: 0, itemCount: 0 },
    deals:    { attempted: 0, succeeded: 0, itemCount: 0 },
    social:   { attempted: 0, succeeded: 0, itemCount: 0 },
  };

  const results = await Promise.allSettled(
    ALL_ADAPTERS.map((adapter) => adapter.fetch(query, limit)),
  );

  const allItems: RawNewsItem[] = [];

  results.forEach((result, idx) => {
    const adapter = ALL_ADAPTERS[idx];
    const sourceClass = SOURCE_CLASS_MAP[adapter.sourceId] ?? 'media';
    classCoverage[sourceClass].attempted++;

    if (result.status === 'fulfilled') {
      const count = result.value.length;
      sourceBreakdown[adapter.sourceId] = count;
      allItems.push(...result.value);
      if (count > 0) {
        classCoverage[sourceClass].succeeded++;
        classCoverage[sourceClass].itemCount += count;
      }
    } else {
      sourceBreakdown[adapter.sourceId] = 0;
      errors.push(`${adapter.sourceId}: ${result.reason?.message ?? 'unknown error'}`);
    }
  });

  // Deduplicate by URL within this batch (cross-source overlap)
  const seen = new Set<string>();
  const deduped: RawNewsItem[] = [];
  for (const item of allItems) {
    const key = item.url || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  // Log coverage summary
  const coverageSummary = Object.entries(classCoverage)
    .map(([cls, c]) => `${cls}=${c.succeeded}/${c.attempted}(${c.itemCount} items)`)
    .join(' ');
  log.info('Source class coverage', { coverage: coverageSummary });

  // Adapter validation warnings — surface unconfigured adapters
  const envWarnings: string[] = [];
  if (!process.env.BSE_ANNOUNCEMENTS_RSS && !process.env.NSE_ANNOUNCEMENTS_RSS) {
    envWarnings.push('official_exchange: BSE_ANNOUNCEMENTS_RSS / NSE_ANNOUNCEMENTS_RSS not configured');
  }
  if (!process.env.CORPORATE_FILINGS_API_URL) {
    envWarnings.push('corporate_filings: CORPORATE_FILINGS_API_URL not configured');
  }
  if (!process.env.DEALS_FEED_API_URL) {
    envWarnings.push('deals_feed: DEALS_FEED_API_URL not configured');
  }
  if (!process.env.SOCIAL_SIGNALS_API_URL) {
    envWarnings.push('social_signals: SOCIAL_SIGNALS_API_URL not configured');
  }
  if (envWarnings.length > 0) {
    log.warn('Unconfigured adapters', { count: envWarnings.length, adapters: envWarnings });
  }

  return { items: deduped, sourceBreakdown, sourceClassCoverage: classCoverage, errors };
}
