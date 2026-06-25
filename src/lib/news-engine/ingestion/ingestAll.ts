// ════════════════════════════════════════════════════════════════
//  Multi-Source Ingestion Orchestrator
//
//  Calls all adapters in parallel, collects RawNewsItem[],
//  returns deduplicated aggregate for normalization.
//
//  Adapters grouped by source class:
//    official - exchange announcements, corporate filings
//    media    - GNews, NewsData, NewsAPI, RSS feeds, Finnhub
//    deals    - M&A, fundraising, contracts
//    social   - social/newswire sentiment signals
// ════════════════════════════════════════════════════════════════

import type {
  NewsAdapter, RawNewsItem, NewsSourceId, NewsSourceClass, NewsSourceStatus,
} from '../types/newsEngine.types';
import { SOURCE_CLASS_MAP } from '../types/newsEngine.types';
import { gnewsAdapter } from './gnewsAdapter';
import { newsDataAdapter } from './newsDataAdapter';
import { newsApiAdapter } from './newsApiAdapter';
import { rssEtAdapter, rssMcAdapter } from './rssAdapter';
import { finnhubAdapter } from './finnhubAdapter';
import { officialExchangeAdapter, corporateFilingsAdapter } from './officialExchangeAdapter';
import { dealsFeedAdapter } from './dealsFeedAdapter';
import { socialSignalsAdapter } from './socialSignalsAdapter';
import { logger } from '@/lib/logger';
import {
  isSourceConfigured,
  enrichSourceHealth,
  collectIngestionHealthWarnings,
  buildExchangeFeedHealth,
  type NewsSourceHealthRow,
} from '../health/newsSourceHealth';

const log = logger.child({ component: 'newsIngestion' });

/**
 * Sentinel passed by the orchestrator when no caller has supplied a
 * specific topic — adapters can detect this and substitute their own
 * specialization (e.g. NewsAPI flips to /top-headlines, GNews fans
 * out across markets/SEBI/earnings OR-terms) instead of doing a
 * literal substring search.
 */
export const DEFAULT_NEWS_QUERY = 'Indian stock market NSE';

const ALL_ADAPTERS: NewsAdapter[] = [
  // Official sources (highest credibility)
  officialExchangeAdapter,
  // Optional premium integration — docs/PREMIUM_NEWS_FEEDS.md
  corporateFilingsAdapter,
  // Media sources (standard credibility)
  gnewsAdapter,
  newsDataAdapter,
  newsApiAdapter,
  rssEtAdapter,
  rssMcAdapter,
  finnhubAdapter,
  // Deals sources (high impact events) — optional; see docs/PREMIUM_NEWS_FEEDS.md
  dealsFeedAdapter,
  // Social sources (lower credibility, higher manipulation scrutiny)
  // Optional; see docs/PREMIUM_NEWS_FEEDS.md
  socialSignalsAdapter,
];

export interface RawIngestionResult {
  items: RawNewsItem[];
  sourceBreakdown: Record<NewsSourceId, number>;
  /** Coverage by source class — which classes returned data. */
  sourceClassCoverage: Record<NewsSourceClass, { attempted: number; succeeded: number; itemCount: number }>;
  errors: string[];
  /** Per-source detailed status (configured, fetched, error, lastFetchedAt). */
  sourceStatus: NewsSourceHealthRow[];
  /** BSE/NSE sub-feed breakdown from official_exchange items this run. */
  exchangeFeedHealth?: import('../health/newsSourceHealth').ExchangeFeedHealth;
  /** ISO timestamp of the newest publishedAt that landed this run. */
  latestNewsPublishedAt: string | null;
}

/**
 * Configuration predicate per source: does the env have what this
 * adapter needs to make a real outbound call? Used to emit the
 * `configured` flag on NewsSourceStatus so the UI / API can show
 * NOT_CONFIGURED honestly instead of silent zeros.
 *
 * Re-exported from newsSourceHealth — single source of truth.
 */
export { isSourceConfigured };

/**
 * Public snapshot of which sources are configured right now — exposed
 * so the /api/news-engine `source-status` action can answer without
 * actually firing the network calls.
 */
export function getConfiguredSourcesSnapshot(): NewsSourceStatus[] {
  return ALL_ADAPTERS.map((a) => ({
    source:        a.sourceId,
    configured:    isSourceConfigured(a.sourceId),
    fetched:       0,
    error:         null,
    lastFetchedAt: null,
  }));
}

/**
 * Fetch from all configured news sources in parallel.
 *
 * @param query  - Search query (e.g. "Indian stock market")
 * @param limit  - Per-source limit
 */
export async function ingestFromAllSources(
  query: string = DEFAULT_NEWS_QUERY,
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
  const completedAt = new Date().toISOString();

  const allItems: RawNewsItem[] = [];
  const sourceStatus: NewsSourceStatus[] = [];

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
      sourceStatus.push({
        source:        adapter.sourceId,
        configured:    isSourceConfigured(adapter.sourceId),
        fetched:       count,
        error:         null,
        lastFetchedAt: completedAt,
      });
    } else {
      sourceBreakdown[adapter.sourceId] = 0;
      const msg = result.reason?.message ?? 'unknown error';
      errors.push(`${adapter.sourceId}: ${msg}`);
      sourceStatus.push({
        source:        adapter.sourceId,
        configured:    isSourceConfigured(adapter.sourceId),
        fetched:       0,
        error:         msg,
        lastFetchedAt: completedAt,
      });
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

  // Adapter health warnings — only legitimate issues (optional sources
  // without API keys are intentionally silent).
  const enrichedStatus = sourceStatus.map((row) => enrichSourceHealth(row, true));
  const healthWarnings = collectIngestionHealthWarnings(enrichedStatus);
  if (healthWarnings.length > 0) {
    log.warn('News source health issues', { count: healthWarnings.length, issues: healthWarnings });
  }

  // Newest publishedAt across this run's items — gives the UI an
  // honest "latest news event" timestamp without re-querying the DB.
  let latestNewsPublishedAt: string | null = null;
  for (const item of deduped) {
    const t = Date.parse(item.publishedAt);
    if (!Number.isFinite(t)) continue;
    if (!latestNewsPublishedAt || t > Date.parse(latestNewsPublishedAt)) {
      latestNewsPublishedAt = item.publishedAt;
    }
  }

  return {
    items: deduped,
    sourceBreakdown,
    sourceClassCoverage: classCoverage,
    errors,
    sourceStatus: enrichedStatus,
    latestNewsPublishedAt,
    exchangeFeedHealth: buildExchangeFeedHealth(
      deduped.filter((i) => i.sourceId === 'official_exchange'),
    ),
  };
}
