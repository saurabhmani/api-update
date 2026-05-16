// ════════════════════════════════════════════════════════════════
//  NewsAPI.org Adapter — news-engine ingestion
//
//  Purpose: general news + source-specific crawling.
//  Use for: business headlines (top-headlines) and fallback
//           coverage when the other media adapters are quiet.
//
//  Endpoint routing:
//    1. Explicit caller query                → /v2/everything?q=…
//       (e.g. orchestrator called with a company name or a focused
//       topic — we want NewsAPI's full corpus, not just headlines)
//    2. NEWSAPI_SOURCES env is set           → /v2/top-headlines?sources=…
//       (operator wants source-specific crawling, e.g.
//       "reuters,bloomberg,the-times-of-india")
//    3. Default broadcast call               → /v2/top-headlines
//       with country=in&category=business (top India business news)
//
//  Soft-fails to [] when NEWSAPI_API_KEY is missing — the orchestrator
//  continues with the other six media sources.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';
import { DEFAULT_NEWS_QUERY } from './ingestAll';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'newsApiAdapter' });

// Accept either env name — the spec uses NEWSAPI_KEY, earlier code used
// NEWSAPI_API_KEY. Honor whichever is set so existing .env files keep
// working alongside new ones.
const NEWSAPI_KEY     = process.env.NEWSAPI_KEY || process.env.NEWSAPI_API_KEY;
const NEWSAPI_SOURCES = process.env.NEWSAPI_SOURCES; // comma-separated NewsAPI source ids

// NewsAPI caps page size at 100 — keep our per-call limit defensive
// to avoid burning the free-tier quota in a single ingestion cycle.
const MAX_PAGE_SIZE = 100;

function buildUrl(query: string, limit: number): string {
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
  const useExplicitQuery = !!query && query !== DEFAULT_NEWS_QUERY;

  if (useExplicitQuery) {
    // Free-text search across the full corpus.
    return (
      `https://newsapi.org/v2/everything` +
      `?q=${encodeURIComponent(query)}` +
      `&language=en` +
      `&sortBy=publishedAt` +
      `&pageSize=${pageSize}`
    );
  }

  if (NEWSAPI_SOURCES) {
    // Source-specific crawling — NewsAPI requires `sources` to be
    // exclusive of `country` / `category`, so we send only sources.
    return (
      `https://newsapi.org/v2/top-headlines` +
      `?sources=${encodeURIComponent(NEWSAPI_SOURCES)}` +
      `&pageSize=${pageSize}`
    );
  }

  // Default: top India business headlines.
  return (
    `https://newsapi.org/v2/top-headlines` +
    `?country=in&category=business` +
    `&pageSize=${pageSize}`
  );
}

export const newsApiAdapter: NewsAdapter = {
  sourceId: 'newsapi',

  async fetch(query: string, limit = 20): Promise<RawNewsItem[]> {
    if (!NEWSAPI_KEY) return [];

    const url = buildUrl(query, limit);

    try {
      // NewsAPI accepts the key via header OR query param; the header
      // path keeps the key out of any URL logging / proxy access logs.
      const res = await fetch(url, {
        headers: { 'X-Api-Key': NEWSAPI_KEY },
        signal:  AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log.warn('Non-OK response', { status: res.status });
        return [];
      }

      const data = await res.json();
      if (data?.status && data.status !== 'ok') {
        log.warn('NewsAPI returned error status', {
          status: data.status, code: data.code, message: data.message,
        });
        return [];
      }

      const now = new Date().toISOString();
      const articles: any[] = Array.isArray(data?.articles) ? data.articles : [];

      return articles
        .slice(0, limit)
        .map((a, i): RawNewsItem | null => {
          const title = String(a?.title ?? '').trim();
          // NewsAPI returns sentinel "[Removed]" rows when an article
          // is retracted upstream — never propagate these downstream.
          if (!title || title === '[Removed]') return null;
          return {
            sourceId:    'newsapi',
            externalId:  a?.url
              ? `newsapi-${a.url}`
              : `newsapi-${a?.publishedAt ?? i}-${Date.now()}`,
            title,
            body:        (String(a?.description ?? '').trim() || null),
            url:         String(a?.url ?? ''),
            publishedAt: a?.publishedAt ?? now,
            fetchedAt:   now,
            rawMeta: {
              sourceId:   a?.source?.id ?? null,
              sourceName: a?.source?.name ?? null,
              author:     a?.author ?? null,
              image:      a?.urlToImage ?? null,
              content:    a?.content ?? null,
              endpoint:   url.includes('/top-headlines') ? 'top-headlines' : 'everything',
            },
          };
        })
        .filter((item): item is RawNewsItem => item !== null);
    } catch (err) {
      log.warn('Fetch failed', { error: (err as Error).message });
      return [];
    }
  },
};
